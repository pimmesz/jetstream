import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  matchProject,
  reduce,
  initialState,
  statusByProject,
  needsAttention,
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
});

describe('needsAttention', () => {
  it('lists projects waiting on the user', () => {
    let s = reduce(initialState(), ev({ event: 'Notification', cwd: '/Users/me/afterburner', sessionId: 'a1' }));
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1' }));
    expect(needsAttention(s, PROJECTS)).toEqual(['ab']);
  });
});

const ALL_STATUSES = ['none', 'idle', 'working', 'needsInput', 'done'] as const;

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
