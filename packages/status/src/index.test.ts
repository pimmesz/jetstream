import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  matchProject,
  reduce,
  initialState,
  statusByProject,
  needsAttention,
  notificationStatus,
  colorFor,
  glyphFor,
  shouldEscalate,
  summarize,
  worstStatus,
  INFLIGHT_TTL_MS,
  type HookEvent,
  type ProjectConfig,
  type ProjectStatus,
} from './index';

const PROJECTS: ProjectConfig[] = [
  { id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' },
  { id: 'osprey', name: 'Osprey', path: '/Users/me/osprey' },
  { id: 'ab', name: 'Afterburner', path: '/Users/me/afterburner' },
];

const ev = (over: Partial<HookEvent>): HookEvent => ({
  event: 'UserPromptSubmit',
  cwd: '/Users/me/falcon',
  sessionId: 's1',
  at: 1000,
  ...over,
});

describe('parseHookPayload', () => {
  it('parses a valid hook payload', () => {
    expect(
      parseHookPayload(
        { hook_event_name: 'Stop', cwd: '/Users/me/falcon', session_id: 'abc' },
        5,
      ),
    ).toEqual({ event: 'Stop', cwd: '/Users/me/falcon', sessionId: 'abc', at: 5 });
  });

  it('rejects unknown events and malformed payloads', () => {
    expect(parseHookPayload({ hook_event_name: 'Nope', cwd: '/x', session_id: 'a' }, 1)).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'Stop', session_id: 'a' }, 1)).toBeNull();
    expect(parseHookPayload(null, 1)).toBeNull();
    expect(parseHookPayload('nope', 1)).toBeNull();
  });

  it('extracts tool_name when it is a string, omits it otherwise', () => {
    expect(
      parseHookPayload(
        { hook_event_name: 'PreToolUse', cwd: '/x', session_id: 's', tool_name: 'Bash' },
        7,
      ),
    ).toEqual({ event: 'PreToolUse', cwd: '/x', sessionId: 's', at: 7, toolName: 'Bash' });
    expect(
      parseHookPayload(
        { hook_event_name: 'PreToolUse', cwd: '/x', session_id: 's', tool_name: 42 },
        7,
      ),
    ).toEqual({ event: 'PreToolUse', cwd: '/x', sessionId: 's', at: 7 });
  });

  it('extracts agent_id on subagent events, omits it when not a string', () => {
    expect(
      parseHookPayload(
        { hook_event_name: 'SubagentStart', cwd: '/x', session_id: 's', agent_id: 'a7' },
        3,
      ),
    ).toEqual({ event: 'SubagentStart', cwd: '/x', sessionId: 's', at: 3, agentId: 'a7' });
    expect(
      parseHookPayload(
        { hook_event_name: 'SubagentStop', cwd: '/x', session_id: 's', agent_id: 9 },
        3,
      ),
    ).toEqual({ event: 'SubagentStop', cwd: '/x', sessionId: 's', at: 3 });
  });
});

describe('matchProject', () => {
  it('matches by path and picks the longest prefix for nested projects', () => {
    expect(matchProject('/Users/me/falcon', PROJECTS)).toBe('falcon');
    expect(matchProject('/Users/me/falcon/src/deep', PROJECTS)).toBe('falcon');
    expect(matchProject('/Users/me/elsewhere', PROJECTS)).toBeUndefined();
    const nested = [
      { id: 'root', name: 'r', path: '/Users/me' },
      { id: 'falcon', name: 'h', path: '/Users/me/falcon' },
    ];
    expect(matchProject('/Users/me/falcon/x', nested)).toBe('falcon');
  });

  it("does not match a sibling that shares a name prefix", () => {
    expect(matchProject('/Users/me/falcon-two', PROJECTS)).toBeUndefined();
  });

  it('an unconfigured key (empty path) matches NOTHING, not every absolute cwd', () => {
    const withUnset = [{ id: 'unset', name: '?', path: '' }, ...PROJECTS];
    expect(matchProject('/Users/me/falcon', withUnset)).toBe('falcon'); // real key still wins
    expect(matchProject('/some/random/dir', withUnset)).toBeUndefined(); // no phantom scoop
    // A real root path is intentional (not the same as an unset key) and still matches.
    expect(matchProject('/some/random/dir', [{ id: 'root', name: 'r', path: '/' }])).toBe('root');
  });
});

// A turn killed by the API fires StopFailure and NOT Stop. Before this existed the session stayed
// pinned 'working' until the 20-min stall glyph gave up — the board could not tell finished from
// died, which is the one distinction it exists to make.
describe('StopFailure → failed', () => {
  it('does not leave a killed turn pinned working', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('working');
    s = reduce(s, ev({ event: 'StopFailure', sessionId: 'h1', at: 2 }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('failed');
  });

  it('is distinct from done — a died turn must not read as finished', () => {
    const failed = reduce(initialState(), ev({ event: 'StopFailure', sessionId: 'h1', at: 1 }));
    const done = reduce(initialState(), ev({ event: 'Stop', sessionId: 'h1', at: 1 }));
    expect(statusByProject(failed, PROJECTS).falcon?.status).not.toBe(
      statusByProject(done, PROJECTS).falcon?.status,
    );
  });

  it('outranks working/done in the roll-up, and rings the doorbell', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'StopFailure', sessionId: 'h2', cwd: '/Users/me/osprey', at: 2 }));
    const by = statusByProject(s, PROJECTS);
    expect(worstStatus(by)).toBe('failed'); // beats the still-'working' sibling
    expect(needsAttention(s, PROJECTS)).toContain('osprey'); // nothing else would surface it
    expect(summarize(by).waiting).toBeGreaterThan(0); // and it can't vanish from the roll-up
  });
});

// The /hook endpoint is unauthenticated, so cwd + session_id are untrusted AND become map keys
// that get serialized to disk. Both the length and the count must be bounded.
describe('untrusted hook payload bounds', () => {
  it('rejects an absurdly long cwd or session_id instead of storing it', () => {
    expect(parseHookPayload({ hook_event_name: 'SessionStart', cwd: 'x'.repeat(4097), session_id: 'h1' }, 1)).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'SessionStart', cwd: '/x', session_id: 'h'.repeat(129) }, 1)).toBeNull();
    // Realistic values still parse — the bound is a ceiling, not a format check.
    expect(parseHookPayload({ hook_event_name: 'SessionStart', cwd: '/Users/me/repo', session_id: 'h1' }, 1)).not.toBeNull();
  });

  it('caps the session map, evicting the oldest, so a flood cannot pin memory or disk', () => {
    let s = initialState();
    for (let i = 0; i < 400; i++) {
      s = reduce(s, ev({ event: 'SessionStart', sessionId: `flood-${i}`, at: i + 1 }));
    }
    const ids = Object.keys(s.sessions);
    expect(ids.length).toBeLessThanOrEqual(256);
    expect(ids).toContain('flood-399'); // newest kept
    expect(ids).not.toContain('flood-0'); // oldest evicted
  });
});

describe('reduce + statusByProject', () => {
  it('maps the lifecycle to colours per project', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'SessionStart', sessionId: 'h1', at: 1 })); // falcon idle
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 2 })); // falcon working
    s = reduce(s, ev({ event: 'Stop', cwd: '/Users/me/osprey', sessionId: 'j1', at: 3 })); // osprey done
    s = reduce(s, ev({ event: 'Notification', cwd: '/Users/me/afterburner', sessionId: 'a1', at: 4 })); // ab needsInput

    const by = statusByProject(s, PROJECTS);
    expect(by.falcon).toEqual({ status: 'working', since: 2 });
    expect(by.osprey).toEqual({ status: 'done', since: 3 });
    expect(by.ab).toEqual({ status: 'needsInput', since: 4 });
  });

  it('SessionEnd forgets the session (back to none)', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('working');
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('none');
  });

  it('aggregates multiple sessions by priority (needsInput wins) with earliest since', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 10 }));
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h2', at: 20 }));
    expect(statusByProject(s, PROJECTS).falcon).toEqual({ status: 'needsInput', since: 20 });
  });
});

describe('subagent tracking (a running workflow keeps a key working)', () => {
  it('a Stop that yields to an in-flight subagent reads working, not done', () => {
    // The bug: a dynamic workflow fires Stop when the main turn yields, but its subagents keep
    // working. Without this, the key falls to done/idle while the workflow is still running.
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 })); // working
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 2, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 3 })); // main turn yields → base done
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('working');
  });

  it('clears back to the base status only once EVERY subagent stops', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 2, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 3, agentId: 'w2' }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 4 }));
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 5, agentId: 'w1' }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('working'); // w2 still running
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 6, agentId: 'w2' }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('done'); // all done → base shows
  });

  it('a new user turn keeps tracking a workflow that is still running', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 2, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 3 }));
    // The user asks something new mid-workflow; that turn ends too — the workflow must still count.
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 4 }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 5 }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('working');
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 6, agentId: 'w1' }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('done');
  });

  it('a lost SubagentStop self-heals: the entry ages out after INFLIGHT_TTL_MS', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1_000 }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 2_000, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 3_000 }));
    // The SubagentStop for w1 is never delivered (fire-and-forget POST dropped).
    expect(statusByProject(s, PROJECTS, 4_000).falcon?.status).toBe('working'); // still fresh
    expect(statusByProject(s, PROJECTS, 2_000 + INFLIGHT_TTL_MS - 1).falcon?.status).toBe('working');
    expect(statusByProject(s, PROJECTS, 2_000 + INFLIGHT_TTL_MS).falcon?.status).toBe('done'); // aged out
  });

  it('a duplicate SubagentStart refreshes the entry instead of double-counting', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1_000 }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 2_000, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 5_000, agentId: 'w1' })); // re-report
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 6_000 }));
    // One Stop for the id clears it — no ghost twin left behind.
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 7_000, agentId: 'w1' }));
    expect(statusByProject(s, PROJECTS, 8_000).falcon?.status).toBe('done');
  });

  it('an unseen session seeded by SubagentStart reads working ONLY while the agent is live', () => {
    let s = reduce(
      initialState(),
      ev({ event: 'SubagentStart', sessionId: 'x', at: 1_000, agentId: 'w1' }),
    );
    // The seed itself is 'idle' — the LIVE inflight entry supplies 'working'…
    expect(statusByProject(s, PROJECTS, 2_000).falcon?.status).toBe('working');
    // …so a delivered Stop settles it back instead of pinning orange,
    const stopped = reduce(s, ev({ event: 'SubagentStop', sessionId: 'x', at: 3_000, agentId: 'w1' }));
    expect(statusByProject(stopped, PROJECTS, 4_000).falcon?.status).toBe('idle');
    // …and a LOST Stop ages out at the TTL rather than pinning forever (the seeded-base bug).
    expect(statusByProject(s, PROJECTS, 1_000 + INFLIGHT_TTL_MS).falcon?.status).toBe('idle');
  });

  it('a SubagentStop delivered BEFORE its Start cancels the pair (no 30-minute false working)', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1_000 }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 2_000 })); // base: done
    // The fast agent's Stop wins the POST race; its Start lands afterwards.
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 3_000, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 3_050, agentId: 'w1' }));
    expect(statusByProject(s, PROJECTS, 4_000).falcon?.status).toBe('done'); // pair cancelled
  });

  it('SessionEnd forgets in-flight subagents (back to none)', () => {
    let s = reduce(initialState(), ev({ event: 'SubagentStart', sessionId: 'h1', at: 1, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1', at: 2 }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('none');
  });

  it('never downgrades a more urgent status — needsInput with a subagent running stays needsInput', () => {
    let s = reduce(initialState(), ev({ event: 'SubagentStart', sessionId: 'h1', at: 1, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h1', at: 2 })); // needs input, subagent still in flight
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('needsInput');
  });

  it('a duplicate SubagentStop for an unknown agent is a no-op', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 2, agentId: 'ghost' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('working'); // base unchanged, no inflight
  });

  it('a SubagentStop for an unknown session never resurrects it (no phantom working)', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'SubagentStart', sessionId: 'h1', at: 1, agentId: 'w1' }));
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1', at: 2 })); // user ends the session
    // A late SubagentStop lands after SessionEnd (independent, unordered hook POSTs).
    s = reduce(s, ev({ event: 'SubagentStop', sessionId: 'h1', at: 3, agentId: 'w1' }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('none'); // stays gone, not phantom working
  });

  it('a straggler base event after SessionEnd never resurrects a ghost (no phantom working)', () => {
    let s = reduce(initialState(), ev({ event: 'PostToolUse', sessionId: 'h1', at: 1 })); // working
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1', at: 2 })); // user ends the session
    // A PostToolUse reordered after the SessionEnd (independent hook POSTs) would otherwise
    // re-create a 'working' key that no future SessionEnd can ever clear.
    s = reduce(s, ev({ event: 'PostToolUse', sessionId: 'h1', at: 3 }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('none'); // stays gone

    // …and a Stop straggler (the other end-of-turn event that races SessionEnd) is just as dead.
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 4 }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('none');
  });

  it('the tombstone is per-session — a brand-new session still registers on its first event', () => {
    let s = reduce(initialState(), ev({ event: 'PostToolUse', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1', at: 2 })); // h1 tombstoned
    // A DIFFERENT session in the same repo must be unaffected (ids never repeat, so only h1 is dead).
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h2', at: 3 }));
    expect(statusByProject(s, PROJECTS, 10).falcon?.status).toBe('done');
  });

  it('the tombstone ages out after the TTL — a straggler beyond it can still create', () => {
    let s = reduce(initialState(), ev({ event: 'PostToolUse', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1', at: 2 }));
    // Far beyond INFLIGHT_TTL_MS the tombstone no longer blocks (bounded memory, not a permanent ban).
    const late = 2 + INFLIGHT_TTL_MS + 1;
    s = reduce(s, ev({ event: 'PostToolUse', sessionId: 'h1', at: late }));
    expect(statusByProject(s, PROJECTS, late).falcon?.status).toBe('working');
  });
});

describe('needsAttention', () => {
  it('lists projects waiting on the user', () => {
    let s = reduce(initialState(), ev({ event: 'Notification', cwd: '/Users/me/afterburner', sessionId: 'a1' }));
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1' }));
    expect(needsAttention(s, PROJECTS)).toEqual(['ab']);
  });

  // The doorbell shows and JUMPS TO the head of this list, so with a mixed set the order decides
  // which project you are sent to. A blocking prompt outranks a died turn; config order must not.
  it('puts a blocking prompt ahead of a died turn, whatever order the projects are configured in', () => {
    // falcon is FIRST in PROJECTS, so config order alone would hand it the doorbell.
    let s = reduce(initialState(), ev({ event: 'StopFailure', cwd: '/Users/me/falcon', sessionId: 'f1', at: 1 }));
    s = reduce(s, ev({ event: 'Notification', cwd: '/Users/me/osprey', sessionId: 'o1', at: 2 }));
    expect(needsAttention(s, PROJECTS)).toEqual(['osprey', 'falcon']);
  });

  it('breaks ties on age — whoever has been waiting longest comes first', () => {
    let s = reduce(initialState(), ev({ event: 'Notification', cwd: '/Users/me/osprey', sessionId: 'o1', at: 50 }));
    s = reduce(s, ev({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 'f1', at: 10 }));
    expect(needsAttention(s, PROJECTS)).toEqual(['falcon', 'osprey']);
  });
});

// EVERY status — a missing entry here would let a new status ship with no colour or glyph.
const ALL_STATUSES = ['none', 'idle', 'working', 'needsInput', 'done', 'failed'] as const;

describe('colorFor', () => {
  it('is defined for every status in both themes', () => {
    for (const status of ALL_STATUSES) {
      expect(colorFor(status)).toMatch(/^#[0-9a-f]{6}$/);
      expect(colorFor(status, 'highContrast')).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('reserves danger-red — no project status is #e5484d in either theme', () => {
    for (const status of ALL_STATUSES) {
      expect(colorFor(status)).not.toBe('#e5484d');
      expect(colorFor(status, 'highContrast')).not.toBe('#e5484d');
    }
  });

  it('highContrast still distinguishes done from the default theme', () => {
    expect(colorFor('done', 'highContrast')).not.toBe(colorFor('done'));
  });
});

describe('glyphFor', () => {
  it('gives a distinct non-colour glyph per active status', () => {
    const glyphs = (['working', 'needsInput', 'done', 'idle'] as ProjectStatus[]).map(glyphFor);
    expect(new Set(glyphs).size).toBe(glyphs.length); // all distinct
    expect(glyphFor('none')).toBe('');
  });
});

describe('shouldEscalate', () => {
  it('escalates only once the wait passes the threshold', () => {
    expect(shouldEscalate(1000, 1000 + 120_000, 120_000)).toBe(true);
    expect(shouldEscalate(1000, 1000 + 60_000, 120_000)).toBe(false);
    expect(shouldEscalate(undefined, 999, 120_000)).toBe(false);
    expect(shouldEscalate(Number.NaN, 999, 120_000)).toBe(false);
  });
});

describe('tool detail (opt-in PreToolUse/PostToolUse)', () => {
  const P: ProjectConfig[] = [{ id: 'p', name: 'P', path: '/w' }];
  it('surfaces the tool during PreToolUse and clears it after PostToolUse', () => {
    let s = reduce(initialState(), {
      event: 'PreToolUse',
      cwd: '/w',
      sessionId: 's',
      at: 1,
      toolName: 'Bash',
    });
    expect(statusByProject(s, P).p).toEqual({ status: 'working', since: 1, tool: 'Bash' });
    s = reduce(s, { event: 'PostToolUse', cwd: '/w', sessionId: 's', at: 2 });
    expect(statusByProject(s, P).p).toEqual({ status: 'working', since: 2 });
  });
});

describe('summarize / worstStatus (fleet roll-up)', () => {
  const by = {
    a: { status: 'working' as const },
    b: { status: 'working' as const },
    c: { status: 'needsInput' as const },
    d: { status: 'done' as const },
    e: { status: 'idle' as const },
    f: { status: 'none' as const }, // ignored — no live session
  };

  it('counts projects by live state, ignoring none', () => {
    expect(summarize(by)).toEqual({ working: 2, waiting: 1, done: 1, idle: 1 });
  });

  it('is all-zero for an empty or all-none fleet', () => {
    expect(summarize({})).toEqual({ working: 0, waiting: 0, done: 0, idle: 0 });
    expect(summarize({ x: { status: 'none' } })).toEqual({
      working: 0,
      waiting: 0,
      done: 0,
      idle: 0,
    });
  });

  it('worstStatus picks the highest priority present (needsInput > working > done > idle)', () => {
    expect(worstStatus(by)).toBe('needsInput');
    expect(worstStatus({ a: { status: 'working' }, b: { status: 'done' } })).toBe('working');
    expect(worstStatus({ a: { status: 'done' }, b: { status: 'idle' } })).toBe('done');
    expect(worstStatus({})).toBe('none');
  });
});

// Claude fires Notification for several unrelated things. Treating them all as "needs you" made
// amber meaningless: the most frequent by far is `idle_prompt`, a 60-second nudge sent AFTER a turn
// has already finished — so a resting `done` key flipped to amber "answer" a minute after every
// turn, taking its +120/-40 diff badge with it, and outranked genuinely-working repos.
describe('Notification triage', () => {
  it('only a notification that truly blocks on a human means needsInput', () => {
    expect(notificationStatus('agent_needs_input')).toBe('needsInput');
    expect(notificationStatus('worker_permission_prompt')).toBe('needsInput');
    expect(notificationStatus('elicitation_dialog')).toBe('needsInput');
  });

  it('informational notifications leave the status ALONE', () => {
    for (const type of ['idle_prompt', 'agent_completed', 'auth_success', 'push_notification']) {
      expect(notificationStatus(type), type).toBeUndefined();
    }
  });

  it('an older Claude with no notification_type keeps the previous behaviour', () => {
    expect(notificationStatus(undefined)).toBe('needsInput');
  });

  it('an idle nudge does not disturb a finished turn', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'Stop', sessionId: 'h1', at: 2 }));
    expect(statusByProject(s, PROJECTS).falcon).toEqual({ status: 'done', since: 2 });
    // 60s later Claude nudges. The key must stay green — with its `since`, so the elapsed timer
    // and the diff badge survive.
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h1', at: 62_000, notificationType: 'idle_prompt' }));
    expect(statusByProject(s, PROJECTS).falcon).toEqual({ status: 'done', since: 2 });
  });

  it('an idle nudge does not outrank a repo that is actually working', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h1', at: 2, notificationType: 'idle_prompt' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('working');
    expect(needsAttention(s, PROJECTS)).toEqual([]); // and it must not ring the doorbell
  });

  it('a real permission prompt still lights amber', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h1', at: 2, notificationType: 'worker_permission_prompt' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('needsInput');
  });
});

// The blocking set is an ALLOWLIST taken from Claude's own hook matcher metadata. Two mistakes are
// easy here and both are silent: missing `permission_prompt` kills the doorbell for every user who
// has NOT bypassed permissions, and matching `elicitation_` by prefix catches the dialog's own
// completion events and flips a finished key back to "needs you".
describe('Notification vocabulary (verified against Claude 2.1.216)', () => {
  it('every blocking type rings, including the plain permission_prompt', () => {
    for (const type of ['permission_prompt', 'worker_permission_prompt', 'agent_needs_input', 'elicitation_dialog']) {
      expect(notificationStatus(type), type).toBe('needsInput');
    }
  });

  it('an elicitation CLOSING is not a request — it must not re-raise the key', () => {
    expect(notificationStatus('elicitation_complete')).toBeUndefined();
    expect(notificationStatus('elicitation_response')).toBeUndefined();
  });

  it('a permission prompt still lights a done key amber (the non-bypass doorbell)', () => {
    let s = reduce(initialState(), ev({ event: 'Stop', sessionId: 'h1', at: 1 }));
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h1', at: 2, notificationType: 'permission_prompt' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('needsInput');
  });
});
