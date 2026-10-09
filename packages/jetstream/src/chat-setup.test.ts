import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import { clarifyingQuestion, parseProposal, runChatSetup, SETUP_SYSTEM } from './chat-setup';
import { pendingStore, type PendingEdit, type PendingStore } from './chat-pending';
import { applyLayout, SLOT, type ApplyDeps, type ApplyOutcome } from './chat-apply';
import type { StoredAction } from './profile-store';
import { coordToCell, sameSlot, storedSlotSettings } from './slot-command';
import { KEY_TYPE_NAMES, type Placement } from './layout';
import { DECK_MODELS, type DeckModel } from './profile';
import type { BoardKey, BoardLayout } from './board-layout';

describe('clarifyingQuestion', () => {
  it('extracts a QUESTION reply, else null', () => {
    expect(clarifyingQuestion('QUESTION: which folder?')).toBe('which folder?');
    expect(clarifyingQuestion('  QUESTION:   spaced   ')).toBe('spaced');
    expect(clarifyingQuestion('{"projects":[]}')).toBeNull();
  });
});

describe('parseProposal', () => {
  it('parses + canonicalizes a fleet and type-checks settings', () => {
    const p = parseProposal(
      '{"projects":[{"name":"Falcon","path":"/repo/falcon"}],"settings":{"theme":"highContrast","longPressMs":800}}',
    );
    expect(p?.projects).toHaveLength(1);
    expect(p?.projects[0]).toMatchObject({ name: 'Falcon', path: '/repo/falcon' });
    expect(p?.settings).toEqual({ theme: 'highContrast', longPressMs: 800 });
  });

  it('drops path-less entries and dedups by resolved path', () => {
    const p = parseProposal(
      '{"projects":[{"name":"A","path":"/a"},{"name":"B"},{"name":"A2","path":"/a"}]}',
    );
    expect(p?.projects).toHaveLength(1); // no-path dropped, /a deduped
    expect(p?.projects[0]?.path).toBe('/a');
  });

  it('ignores bad settings types (clamping happens at plugin load)', () => {
    const p = parseProposal(
      '{"projects":[{"path":"/a"}],"settings":{"theme":"bogus","longPressMs":"x"}}',
    );
    expect(p?.settings).toEqual({});
  });

  it('returns null for a non-fleet reply', () => {
    expect(parseProposal('not json')).toBeNull();
    expect(parseProposal('{"nope":1}')).toBeNull();
    expect(parseProposal('QUESTION: where?')).toBeNull();
  });

  it('accepts a layout-only reply that omits "projects" (the "add a key at a8" case)', () => {
    const p = parseProposal(
      '{"layout":{"deck":"xl","keys":[{"coord":"a8","type":"open-app","app":"/Applications/Telegram.app"}]}}',
    );
    expect(p?.projects).toHaveLength(0);
    expect(p?.layout?.deck.key).toBe('xl');
    expect(p?.layout?.placements[0]).toMatchObject({
      column: 7,
      row: 0,
      uuid: 'gg.pim.jetstream.slot', // open-app now places a live-editable slot, not a native key
      settings: { kind: 'app', app: '/Applications/Telegram.app' },
    });
  });

  it('falls back to the board deck when the model omits "deck", and unwraps prose/fenced JSON', () => {
    const xl = DECK_MODELS.find((d) => d.key === 'xl');
    const reply =
      'Sure! ```json\n{"layout":{"keys":[{"coord":"a8","type":"open-app","app":"/Applications/Telegram.app"}]}}\n```';
    const p = parseProposal(reply, xl);
    expect(p?.layout?.deck.key).toBe('xl');
    expect(p?.layout?.placements[0]).toMatchObject({ column: 7, row: 0 });
  });

  it('reports dropped keys — an unknown type is refused, not silently placed', () => {
    const p = parseProposal(
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"usage"},{"coord":"a2","type":"nope"}]}}',
    );
    expect(p?.layout?.placements).toHaveLength(1); // only usage resolved
    expect(p?.layout?.dropped).toBe(1); // the unknown "nope" was dropped
  });
});

describe('SETUP_SYSTEM ↔ KEY_TYPES coverage', () => {
  // Guards the hand-authored key catalogue in the prompt: resolvePlacements accepts anything in
  // KEY_TYPES, so any type the prompt fails to mention is placeable but never proposed. The
  // no-settings tail is derived from NO_SETTINGS_TYPE_NAMES; this catches drift in the rest.
  it('documents every placeable key type in the model prompt', () => {
    const undocumented = KEY_TYPE_NAMES.filter(
      // Boundary match so "run" isn't satisfied by "runner"; hyphens (open-app, stop-all) count as part of the name.
      (name) => !new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(SETUP_SYSTEM),
    );
    expect(undocumented).toEqual([]);
  });

  // The inverse, and the one that actually bit: when a key type is DELETED from the plugin, the
  // prompt keeps advertising it, so the model confidently proposes a key resolvePlacements will
  // then reject — the user sees their request silently dropped. (This is how the removed `launch`
  // type survived its own deletion.)
  it('advertises no key type the plugin cannot actually place', () => {
    const lines = SETUP_SYSTEM.split('\n');
    const start = lines.findIndex((l) => l.includes('"type" is one of:'));
    const end = lines.findIndex((l, i) => i > start && l.includes('"icon" is'));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const advertised = lines
      .slice(start + 1, end)
      .flatMap((l) => l.split('·'))
      .map((entry) => /^[a-z][a-z-]*/.exec(entry.trim())?.[0])
      .filter((name): name is string => Boolean(name));
    expect(advertised.length).toBeGreaterThan(5); // the parse found a real catalogue, not nothing
    expect(advertised.filter((name) => !KEY_TYPE_NAMES.includes(name))).toEqual([]);
  });

  // Third-party keys (Hue / Spotify / OBS / ...) are placed as COPIES of keys the user already has, by
  // catalogue ref only. The prompt must say so, and must still give an honest route when no copy exists.
  it('tells the model to place third-party keys by catalogue ref, and what to do without one', () => {
    expect(SETUP_SYSTEM).toMatch(/other Stream Deck plugins/i);
    expect(SETUP_SYSTEM).toMatch(/"type":"plugin","ref"/);
    expect(SETUP_SYSTEM).toMatch(/Never invent a ref/);
    expect(SETUP_SYSTEM).toMatch(/QUESTION/); // no copy available: a question, not a dead end
    expect(SETUP_SYSTEM).toMatch(/`run`|open-url/); // with the run / open-url fallback
  });
});

/** Scripted IO: queued answers to `ask`, captured `say` lines. */
describe('runChatSetup preflight', () => {
  it('fails fast (exit 1) with a hint when `claude` is not on PATH — no round-trip taken', async () => {
    const said: string[] = [];
    const io = { ask: async () => '', say: (l: string) => said.push(l) };
    const ask = vi.fn(async () => null);
    const code = await runChatSetup({ io, ask, claudeAvailable: () => false });
    expect(code).toBe(1);
    expect(ask).not.toHaveBeenCalled(); // never spent a claude turn
    expect(said.join('\n')).toMatch(/jetstream init/);
  });

  it('proceeds into the loop when `claude` is available', async () => {
    const said: string[] = [];
    const io = { ask: async () => 'cancel', say: (l: string) => said.push(l) };
    const ask = vi.fn(async () => null);
    const code = await runChatSetup({ io, ask, claudeAvailable: () => true });
    expect(code).toBe(0); // reached the loop; user cancelled
    expect(ask).not.toHaveBeenCalled(); // "cancel" short-circuits before the model
  });
});

function makeIo(answers: string[]): {
  io: { ask: (q: string) => Promise<string>; say: (l: string) => void };
  said: string[];
} {
  const said: string[] = [];
  let i = 0;
  // Out of scripted answers means the user leaves, as EOF does on a real terminal.
  return { io: { ask: async () => answers[i++] ?? 'quit', say: (l) => said.push(l) }, said };
}

describe('runChatSetup', () => {
  it('describe → propose → apply writes the validated fleet', async () => {
    const { io } = makeIo(['3 repos in /dev', 'y']);
    const replies = ['{"projects":[{"name":"Falcon","path":"/dev/falcon"}]}'];
    let r = 0;
    const write = vi.fn();
    const code = await runChatSetup({
      io,
      ask: async () => replies[r++] ?? null,
      write,
      configPath: '/tmp/p.json',
    });
    expect(code).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toHaveLength(1);
  });

  it('places a copy of a catalogued third-party key (Hue) with the settings from disk', async () => {
    const { io, said } = makeIo(['make d6 toggle my hue light', 'y']);
    const catalog = [
      {
        ref: 'philips-hue-power-1',
        uuid: 'com.elgato.philipshue.power',
        title: 'Philips Hue power',
        target: 'Desk lamp',
        settings: { bridge: 'b1', id: 'light-1', type: 'light' },
        plugin: { Name: 'Philips Hue', UUID: 'com.elgato.philipshue', Version: '2.2.1.15' },
        states: [{}, {}],
      },
    ];
    const onLayout = vi.fn(
      async (_p: Placement[], _t: { deck: DeckModel; board: BoardLayout | null }) =>
        'restarted' as const,
    );
    const ask = async () =>
      '{"layout":{"deck":"xl","keys":[{"coord":"d6","type":"plugin","ref":"philips-hue-power-1"}]}}';
    await runChatSetup({ io, ask, onLayout, catalog, configPath: '/x' });
    expect(onLayout).toHaveBeenCalledTimes(1);
    const placed = onLayout.mock.calls[0]![0][0]!;
    expect(placed).toMatchObject({ column: 5, row: 3, uuid: 'com.elgato.philipshue.power' });
    expect(placed.settings).toEqual({ bridge: 'b1', id: 'light-1', type: 'light' });
    // The proposal's deck travels with it, so a first board is built for the right model.
    expect(onLayout.mock.calls[0]![1]).toMatchObject({ deck: { key: 'xl' }, board: null });
    expect(said.some((l) => /d6: Philips Hue power/.test(l))).toBe(true); // shown in the plan first
  });

  it('after a live apply, the next request plans against the applied key even if the disk is stale', async () => {
    const xl = DECK_MODELS.find((d) => d.key === 'xl')!;
    const stale: BoardLayout = {
      profileName: 'Jetstream',
      profileDir: '/p.sdProfile',
      deck: xl,
      keys: new Map([
        ['0,0', { uuid: 'gg.pim.jetstream.slot', settings: { kind: 'empty' }, label: '·' }],
      ]),
      allUuids: [],
    };
    const { io } = makeIo(['put telegram at a1', 'y', 'make a1 a url', 'y']);
    const replies = [
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://t.me"}]}}',
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://x.dev"}]}}',
    ];
    let r = 0;
    const seen: Array<BoardLayout | null> = [];
    const onLayout = vi.fn(
      async (_p: Placement[], t: { deck: DeckModel; board: BoardLayout | null }) => {
        seen.push(t.board);
        return 'live' as const;
      },
    );
    await runChatSetup({
      io,
      ask: async () => replies[r++] ?? null,
      onLayout,
      board: stale,
      readBoard: () => stale,
      configPath: '/x',
    });
    expect(onLayout).toHaveBeenCalledTimes(2);
    expect(seen[1]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://t.me' });
  });

  it('remembers every live edit until disk shows it, and never lays them over another page', async () => {
    const xl = DECK_MODELS.find((d) => d.key === 'xl')!;
    const empty = { uuid: 'gg.pim.jetstream.slot', settings: { kind: 'empty' }, label: '·' };
    const pageA: BoardLayout = {
      profileName: 'J',
      profileDir: '/p.sdProfile',
      pageId: 'a',
      deck: xl,
      keys: new Map([
        ['0,0', empty],
        ['1,0', empty],
      ]),
      allUuids: [],
    };
    const pageB: BoardLayout = {
      ...pageA,
      pageId: 'b',
      keys: new Map([
        ['0,0', empty],
        ['1,0', empty],
      ]),
    };
    let onScreen = pageA;
    const { io } = makeIo(['a1', 'y', 'a2', 'y', 'a1 again', 'y']);
    const replies = [
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://one.dev"}]}}',
      '{"layout":{"deck":"xl","keys":[{"coord":"a2","type":"open-url","url":"https://two.dev"}]}}',
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://three.dev"}]}}',
    ];
    let r = 0;
    const seen: Array<BoardLayout | null> = [];
    const onLayout = vi.fn(
      async (_p: Placement[], t: { deck: DeckModel; board: BoardLayout | null }) => {
        seen.push(t.board);
        if (seen.length === 2) onScreen = pageB; // the user flips to page B after the second edit
        return 'live' as const;
      },
    );
    await runChatSetup({
      io,
      ask: async () => replies[r++] ?? null,
      onLayout,
      board: pageA,
      readBoard: () => onScreen,
      configPath: '/x',
    });
    expect(seen[1]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://one.dev' }); // a1 kept
    expect(seen[2]?.pageId).toBe('b');
    expect(seen[2]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' }); // page A's edits not laid over B
  });

  it('remembers only changed live slots, and forgets them where a restart write replaced the key', async () => {
    const xl = DECK_MODELS.find((d) => d.key === 'xl')!;
    const text = {
      uuid: 'com.elgato.streamdeck.system.text',
      settings: { pastedText: 'hi' },
      label: 'hi',
    };
    const empty = { uuid: 'gg.pim.jetstream.slot', settings: { kind: 'empty' }, label: '·' };
    const stale: BoardLayout = {
      profileName: 'J',
      profileDir: '/p.sdProfile',
      pageId: 'a',
      deck: xl,
      keys: new Map<string, BoardKey>([
        ['0,0', empty],
        ['1,0', text],
      ]),
      allUuids: [],
    };
    const { io } = makeIo(['a1 url', 'y', 'a1 text', 'y', 'look', 'y']);
    const replies = [
      // a live slot edit at a1 that also re-emits the unchanged native text key at a2
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://one.dev"},{"coord":"a2","type":"text","text":"hi"}]}}',
      // a1 becomes a native text key: a restart write
      '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"text","text":"note"}]}}',
      '{"layout":{"deck":"xl","keys":[{"coord":"a3","type":"open-url","url":"https://x.dev"}]}}',
    ];
    let r = 0;
    const seen: Array<BoardLayout | null> = [];
    const outcomes = ['live', 'restarted', 'live'] as const;
    const onLayout = vi.fn(
      async (_p: Placement[], t: { deck: DeckModel; board: BoardLayout | null }) => {
        seen.push(t.board);
        return outcomes[seen.length - 1]!;
      },
    );
    await runChatSetup({
      io,
      ask: async () => replies[r++] ?? null,
      onLayout,
      board: stale,
      readBoard: () => stale,
      configPath: '/x',
    });
    expect(seen[1]?.keys.get('1,0')).toEqual(text); // the untouched native key keeps its real settings
    expect(seen[2]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' }); // the live a1 was superseded
  });

  it('a third-party request with no copy available gets the QUESTION and writes nothing', async () => {
    const { io, said } = makeIo(['add a spotify key to d6']);
    const write = vi.fn();
    const ask = async () =>
      'QUESTION: That needs the Spotify Stream Deck plugin. Place one Spotify key once in the Stream Deck app, then I can copy and move it. Or give me a command for a run key.';
    const code = await runChatSetup({
      io,
      ask,
      write,
      configPath: '/tmp/p.json',
      claudeAvailable: () => true,
    });
    expect(code).toBe(0);
    expect(said.some((l) => /Spotify Stream Deck plugin/.test(l))).toBe(true);
    expect(write).not.toHaveBeenCalled(); // a question is not a proposal
  });

  it('runs onWritten with the written fleet after applying (the layout hook)', async () => {
    const { io } = makeIo(['3 repos in /dev', 'y']);
    const write = vi.fn();
    const onWritten = vi.fn(async (_projects: ProjectConfig[]) => {});
    const code = await runChatSetup({
      io,
      ask: async () =>
        '{"projects":[{"name":"Falcon","path":"/dev/falcon"},{"name":"Api","path":"/dev/api"}]}',
      write,
      onWritten,
      configPath: '/tmp/p.json',
    });
    expect(code).toBe(0);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(onWritten.mock.calls[0]![0].map((p) => p.name)).toEqual(['Falcon', 'Api']);
  });

  it('refuses a PARTIAL layout instead of applying a destructive move (a dropped key would delete a source)', async () => {
    const { io, said } = makeIo(['move things around']);
    const onLayout = vi.fn(async () => {});
    // usage resolves at d1, but the unknown "nope" at d2 is dropped → applying would clear/overwrite
    // without placing everything the model intended. The flow must refuse, not apply the remainder.
    const reply =
      '{"layout":{"deck":"xl","keys":[{"coord":"d2","type":"nope"},{"coord":"d1","type":"usage"}]}}';
    const prompts: string[] = [];
    const code = await runChatSetup({
      io,
      ask: async (prompt) => {
        prompts.push(prompt);
        return reply; // the model repeats the same mistake after the correction
      },
      onLayout,
      configPath: '/x',
    });
    expect(code).toBe(0);
    expect(onLayout).not.toHaveBeenCalled(); // a partial layout is never applied
    // The rejected key went back to the model once, automatically, before the user was told.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/could not be placed: skipped nope at d2: unknown key type/);
    expect(said.some((l) => /nothing was applied/.test(l))).toBe(true);
  });

  it('stays open after an apply, so a second change needs no new session', async () => {
    const { io } = makeIo(['add falcon', 'y', 'add api', 'y']);
    const replies = ['{"projects":[{"path":"/dev/falcon"}]}', '{"projects":[{"path":"/dev/api"}]}'];
    let r = 0;
    const write = vi.fn();
    await runChatSetup({ io, ask: async () => replies[r++] ?? null, write, configPath: '/x' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('shows a plain answer instead of calling it unreadable', async () => {
    const { io, said } = makeIo(['what is on c3?']);
    await runChatSetup({ io, ask: async () => 'ANSWER: c3 opens Telegram.', configPath: '/x' });
    expect(said).toContain('\nc3 opens Telegram.');
  });

  it('says a layout that is already in place changes nothing', async () => {
    const board = {
      profileName: 'Jetstream',
      profileDir: '/store/b.sdProfile',
      deck: DECK_MODELS.find((d) => d.key === 'xl')!,
      keys: new Map([
        [
          '0,0',
          { uuid: 'gg.pim.jetstream.slot', settings: { kind: 'app', app: '/A.app' }, label: 'A' },
        ],
      ]),
      allUuids: [],
    };
    const { io, said } = makeIo(['put A at a1']);
    const onLayout = vi.fn(async () => {});
    await runChatSetup({
      io,
      board,
      ask: async () =>
        '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-app","app":"/A.app"}]}}',
      onLayout,
      configPath: '/x',
    });
    expect(onLayout).not.toHaveBeenCalled();
    expect(said.some((l) => /Already set, nothing to change/.test(l))).toBe(true);
  });

  it('a clarifying question loops, then applies on the next turn', async () => {
    const { io, said } = makeIo(['I have repos', 'in /dev', 'y']);
    const replies = ['QUESTION: where are they?', '{"projects":[{"path":"/dev/a"}]}'];
    let r = 0;
    const write = vi.fn();
    const code = await runChatSetup({
      io,
      ask: async () => replies[r++] ?? null,
      write,
      configPath: '/x',
    });
    expect(code).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(said.some((l) => l.includes('where are they?'))).toBe(true);
  });

  it('refine keeps the loop open, then applies the revised proposal', async () => {
    const { io } = makeIo(['repos', 'r', 'also add web', 'y']);
    const replies = [
      '{"projects":[{"path":"/a"}]}',
      '{"projects":[{"path":"/a"},{"path":"/web"}]}',
    ];
    let r = 0;
    const write = vi.fn();
    await runChatSetup({ io, ask: async () => replies[r++] ?? null, write, configPath: '/x' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toHaveLength(2); // the refined fleet
  });

  it('cancel writes nothing', async () => {
    const { io } = makeIo(['cancel']);
    const write = vi.fn();
    const code = await runChatSetup({ io, ask: async () => null, write });
    expect(code).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('a failed model turn names the cause and keeps the conversation open', async () => {
    const { io, said } = makeIo(['describe my repos', 'describe my repos', 'y']);
    const replies = [{ error: 'usage limit reached' }, '{"projects":[{"path":"/a"}]}'];
    let r = 0;
    const write = vi.fn();
    const code = await runChatSetup({
      io,
      ask: async () => replies[r++] ?? null,
      write,
      configPath: '/x',
    });
    expect(code).toBe(0);
    expect(said.some((l) => /could not answer \(usage limit reached\)/.test(l))).toBe(true);
    expect(write).toHaveBeenCalledTimes(1); // the retry went through
  });

  it('surfaces a write failure as exit 1', async () => {
    const { io } = makeIo(['repos', 'y']);
    const write = vi.fn(() => {
      throw new Error('EROFS');
    });
    const code = await runChatSetup({
      io,
      ask: async () => '{"projects":[{"path":"/a"}]}',
      write,
      configPath: '/x',
    });
    expect(code).toBe(1);
  });

  // These drive the REAL write path (no injected `write`), against a REAL projects.json on disk —
  // the seam every test above skips by pointing configPath at a nonexistent file, which makes
  // readConfigFile return an empty non-corrupt fleet so the merge collapses to a passthrough. That
  // is exactly why the fleet-wipe regression (write the proposal wholesale) would stay green.
  it('MERGES an added repo into an existing fleet on disk — never replaces it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-chat-'));
    const configPath = join(dir, 'projects.json');
    // A populated fleet, exactly what a real user has.
    writeFileSync(
      configPath,
      JSON.stringify({
        projects: [
          { id: 'falcon', name: 'Falcon', path: '/dev/falcon' },
          { id: 'api', name: 'Api', path: '/dev/api' },
          { id: 'web', name: 'Web', path: '/dev/web' },
        ],
      }),
    );
    const { io } = makeIo(['add a repo', 'y']);
    // The model proposes ONLY the new repo — the shape the prompt asks for and the shape that
    // wiped fleets before the merge fix.
    const code = await runChatSetup({
      io,
      ask: async () => '{"projects":[{"name":"New","path":"/dev/new"}]}',
      configPath,
    });
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as { projects: ProjectConfig[] };
    expect(written.projects.map((p) => p.path)).toEqual([
      '/dev/falcon',
      '/dev/api',
      '/dev/web',
      '/dev/new',
    ]); // all four — the three existing PLUS the new one, never the lone proposal
    rmSync(dir, { recursive: true, force: true });
  });

  it('REFUSES to write over a corrupt projects.json, leaving it untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-chat-'));
    const configPath = join(dir, 'projects.json');
    const corrupt = '{ "projects": [ truncated';
    writeFileSync(configPath, corrupt);
    const { io } = makeIo(['add a repo', 'y']);
    const code = await runChatSetup({
      io,
      ask: async () => '{"projects":[{"name":"New","path":"/dev/new"}]}',
      configPath,
    });
    expect(code).toBe(1); // refused
    expect(readFileSync(configPath, 'utf8')).toBe(corrupt); // and did not clobber the file
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('runChatSetup pending live edits', () => {
  const xl = DECK_MODELS.find((d) => d.key === 'xl')!;
  const slotKey = (settings: Record<string, unknown>): BoardKey => ({ uuid: 'gg.pim.jetstream.slot', settings, label: 'k' });
  const empty = slotKey({ kind: 'empty' });
  const page = (keys: Record<string, BoardKey>): BoardLayout => ({
    profileName: 'J',
    profileDir: '/p.sdProfile',
    pageId: 'a',
    deck: xl,
    keys: new Map(Object.entries(keys)),
    allUuids: [],
  });
  const urlAt = (coord: string, url: string): string =>
    `{"layout":{"deck":"xl","keys":[{"coord":"${coord}","type":"open-url","url":"${url}"}]}}`;

  /** Every turn's layout goes live unless it names another `outcome`. `disk` is what the re-read shows after
   * that turn (unchanged when absent, no board when null), and `now` the fake clock once it applied.
   * Returns the board each turn was planned against. */
  async function liveTurns(
    start: BoardLayout,
    turns: Array<{ reply: string; disk?: BoardLayout | null; outcome?: ApplyOutcome; now?: number }>,
    pending?: PendingStore,
  ): Promise<Array<BoardLayout | null>> {
    let disk: BoardLayout | null = start;
    let r = 0;
    const seen: Array<BoardLayout | null> = [];
    const { io } = makeIo(turns.flatMap(() => ['change it', 'y']));
    await runChatSetup({
      io,
      ask: async () => turns[r++]?.reply ?? null,
      onLayout: async (_p: Placement[], t: { deck: DeckModel; board: BoardLayout | null }) => {
        const turn = turns[seen.length];
        if (turn?.disk !== undefined) disk = turn.disk;
        if (turn?.now !== undefined) vi.setSystemTime(turn.now);
        seen.push(t.board);
        return turn?.outcome ?? 'live';
      },
      board: start,
      readBoard: () => disk,
      configPath: '/x',
      pending,
    });
    expect(seen).toHaveLength(turns.length);
    return seen;
  }

  /** A plugin that, like the real one, refuses a write whose `expect` is not what the key holds (409). On a
   * restart Stream Deck saves what the plugin holds, so that is the page the restart compare reads. */
  function fakeDeck(held: Record<string, unknown>) {
    const sent: Array<Record<string, unknown>> = [];
    const sendSlot = async (body: Record<string, unknown>): Promise<number> => {
      sent.push(body);
      const coord = String(body.coord);
      if (!sameSlot(held[coord], body.expect)) return 409;
      held[coord] = storedSlotSettings(body);
      return 200;
    };
    const savedOnQuit = (): Record<string, StoredAction> =>
      Object.fromEntries(
        Object.entries(held).map(([coord, settings]) => {
          const cell = coordToCell(coord)!;
          return [`${cell.column},${cell.row}`, { UUID: SLOT, Settings: settings }];
        }),
      );
    return { held, sent, sendSlot, savedOnQuit };
  }

  /** Chat's real apply against `deck`, wired the way cli.ts wires it. Records each outcome. */
  function applyTo(deck: ReturnType<typeof fakeDeck>, outcomes: ApplyOutcome[], over: Partial<ApplyDeps> = {}) {
    return async (placements: Placement[], t: { board: BoardLayout | null; onConflict: (keys: string[]) => void }) => {
      const outcome = await applyLayout(placements, {
        say: () => {},
        confirm: async () => false,
        board: t.board,
        pluginAlive: async () => true,
        sendSlot: deck.sendSlot,
        writeInPlace: async (_dir, _placements, _pageId, changedSincePlan) => {
          const changed = changedSincePlan(deck.savedOnQuit());
          if (changed.length > 0) return { ok: false, reason: `changed: ${changed.join(', ')}`, changed };
          return { ok: true, backup: '/bak', removed: [] };
        },
        importProfile: () => '/x',
        onConflict: t.onConflict,
        ...over,
      });
      outcomes.push(outcome);
      return outcome;
    };
  }

  it('forgets a live edit as soon as disk shows anything else at that key', async () => {
    // A native key with no settings, which compares equal to an empty slot by settings alone.
    const nextPage: BoardKey = { uuid: 'com.elgato.streamdeck.page.next', settings: {}, label: 'Next Page' };
    const otherChat = slotKey({ kind: 'app', app: '/T.app' });
    const seen = await liveTurns(page({ '0,0': empty, '1,0': empty, '2,0': empty }), [
      {
        reply: '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://one.dev"},{"coord":"a2","type":"open-url","url":"https://two.dev"},{"coord":"a3","type":"open-url","url":"https://gone.dev"}]}}',
        // Before Stream Deck saved any edit, a native key was dragged onto a1, another chat changed a2
        // and a3 was deleted.
        disk: page({ '0,0': nextPage, '1,0': otherChat }),
      },
      { reply: urlAt('a4', 'https://four.dev') },
    ]);
    expect(seen[1]?.keys.has('2,0')).toBe(false);
    expect(seen[1]?.keys.get('0,0')).toEqual(nextPage);
    expect(seen[1]?.keys.get('1,0')).toEqual(otherChat);
  });

  it('keeps the latest live edit to a key while disk still shows the key before any of its edits', async () => {
    const both = (url: string): string =>
      `{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"${url}"},{"coord":"a2","type":"open-url","url":"${url}"}]}}`;
    const one = slotKey({ kind: 'url', url: 'https://one.dev' });
    const seen = await liveTurns(page({ '0,0': empty, '1,0': empty, '2,0': empty }), [
      { reply: both('https://one.dev') },
      // Stream Deck saved a1's first edit only, and neither edit to a2.
      { reply: both('https://two.dev'), disk: page({ '0,0': one, '1,0': empty, '2,0': empty }) },
      { reply: urlAt('a3', 'https://x.dev') },
    ]);
    expect(seen[2]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://two.dev' });
    expect(seen[2]?.keys.get('1,0')?.settings).toEqual({ kind: 'url', url: 'https://two.dev' });
  });

  it('remembers a live edit in the form the plugin stores (a cleared key drops its colour)', async () => {
    const clearRed = '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"slot","color":"red"}]}}';
    expect(parseProposal(clearRed, xl)?.layout?.placements[0]?.settings).toMatchObject({ kind: 'empty', color: expect.any(String) });
    const seen = await liveTurns(page({ '0,0': slotKey({ kind: 'url', url: 'https://one.dev' }), '1,0': empty }), [
      { reply: clearRed },
      { reply: urlAt('a2', 'https://x.dev') },
    ]);
    // What the next live edit at a1 sends as `expect`, so it must match what the plugin holds.
    expect(seen[1]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
  });

  it('forgets a live edit once disk shows it, so a later change made on the deck shows', async () => {
    const seen = await liveTurns(page({ '0,0': empty, '1,0': empty }), [
      { reply: urlAt('a1', 'https://one.dev'), disk: page({ '0,0': slotKey({ kind: 'url', url: 'https://one.dev' }), '1,0': empty }) },
      // a1 was cleared on the deck; a2's edit is not saved yet.
      { reply: urlAt('a2', 'https://two.dev'), disk: page({ '0,0': empty, '1,0': empty }) },
      { reply: urlAt('a2', 'https://three.dev') },
    ]);
    expect(seen[2]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
    expect(seen[2]?.keys.get('1,0')?.settings).toEqual({ kind: 'url', url: 'https://two.dev' });
  });

  it('forgets a live edit once disk shows it, even when it put back what the key held before', async () => {
    const one = slotKey({ kind: 'url', url: 'https://one.dev' });
    const seen = await liveTurns(page({ '0,0': empty, '1,0': empty }), [
      { reply: urlAt('a1', 'https://one.dev') },
      { reply: '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"slot","color":"red"}]}}' }, // disk shows the clear
      { reply: urlAt('a2', 'https://two.dev'), disk: page({ '0,0': one, '1,0': empty }) }, // another chat set a1
      { reply: urlAt('a2', 'https://three.dev') },
    ]);
    expect(seen[3]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://one.dev' });
  });

  it('keeps a live edit, and shows the new one, when a re-read finds no board', async () => {
    const stale = page({ '0,0': empty, '1,0': empty, '2,0': empty, '3,0': empty });
    const seen = await liveTurns(stale, [
      { reply: urlAt('a1', 'https://one.dev') },
      { reply: urlAt('a2', 'https://two.dev'), disk: null },
      { reply: urlAt('a3', 'https://three.dev'), disk: stale },
      { reply: urlAt('a4', 'https://four.dev') },
    ]);
    expect(seen[2]?.keys.get('1,0')?.settings).toEqual({ kind: 'url', url: 'https://two.dev' });
    expect(seen[3]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://one.dev' });
  });

  it('keeps its own live edits past the hour Stream Deck may take to save them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = 1_700_000_000_000;
      vi.setSystemTime(start);
      const seen = await liveTurns(page({ '0,0': empty, '1,0': empty }), [
        { reply: urlAt('a1', 'https://one.dev') },
        { reply: urlAt('a1', 'https://two.dev'), now: start + 61 * 60_000 },
        { reply: urlAt('a2', 'https://x.dev') },
      ]);
      expect(seen[2]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://two.dev' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('moving a key back after another page on screen refused an edit at its old spot never loses it', async () => {
    const Y = { kind: 'url', url: 'https://y.dev' };
    const disk = page({ '0,0': slotKey(Y), '1,0': empty }); // Stream Deck saves none of these edits
    const deck = fakeDeck({ a1: Y, a2: { kind: 'empty' } });
    let isOtherPageOnScreen = false;
    // The other page holds other keys there, so the plugin refuses every edit while it is on screen.
    const sendSlot = async (body: Record<string, unknown>): Promise<number> =>
      isOtherPageOnScreen ? 409 : deck.sendSlot(body);
    const turns = [
      { reply: '{"layout":{"deck":"xl","keys":[{"coord":"a2","type":"open-url","url":"https://y.dev"},{"coord":"a1","type":"slot"}]}}', isOther: false },
      { reply: urlAt('a1', 'https://t.dev'), isOther: true }, // the 409 forgets a1's edit, which the deck still holds
      { reply: '{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"open-url","url":"https://y.dev"},{"coord":"a2","type":"slot"}]}}', isOther: false },
    ];
    let r = 0;
    const outcomes: ApplyOutcome[] = [];
    const { io } = makeIo(turns.flatMap(() => ['change it', 'y']));
    await runChatSetup({
      io,
      ask: async () => {
        isOtherPageOnScreen = turns[r]?.isOther ?? false;
        return turns[r++]?.reply ?? null;
      },
      onLayout: applyTo(deck, outcomes, { sendSlot }),
      board: disk,
      readBoard: () => disk,
      configPath: '/x',
    });
    // The move back planned a1 from disk, so the plugin had to confirm a1 before clearing a2, and refused.
    expect(outcomes).toEqual(['live', 'declined', 'declined']);
    expect(deck.held).toEqual({ a1: { kind: 'empty' }, a2: Y });
  });

  describe('across chats', () => {
    const dirs: string[] = [];
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });
    /** A file store in a temp folder. The chats in one test share it, as every `jetstream chat` shares one file. */
    function fileStore(): { pending: PendingStore; path: string } {
      const dir = mkdtempSync(join(tmpdir(), 'jetstream-chat-pending-'));
      dirs.push(dir);
      const path = join(dir, 'chat-pending.json');
      return { pending: pendingStore(path), path };
    }
    const stale = page({ '0,0': empty, '1,0': empty });
    const one = { kind: 'url', url: 'https://one.dev' };

    it('a new chat plans against a live edit an earlier chat made that disk does not show yet', async () => {
      const { pending } = fileStore();
      await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
      const seen = await liveTurns(stale, [{ reply: urlAt('a2', 'https://two.dev') }], pending);
      expect(seen[0]?.keys.get('0,0')?.settings).toEqual(one);
    });

    it('a new chat shows an unsaved edit in its opening board map', async () => {
      const { pending } = fileStore();
      await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
      const { io, said } = makeIo([]);
      await runChatSetup({ io, ask: async () => null, board: stale, readBoard: () => stale, configPath: '/x', pending });
      expect(said.some((line) => line.includes('a1 one.dev'))).toBe(true);
    });

    it('lays a stored edit over its own profile and page only', async () => {
      const { pending } = fileStore();
      await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
      const onB = await liveTurns({ ...stale, pageId: 'b' }, [{ reply: urlAt('a2', 'https://b.dev') }], pending);
      expect(onB[0]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
      const otherProfile = await liveTurns({ ...stale, profileDir: '/q.sdProfile' }, [{ reply: urlAt('a2', 'https://q.dev') }], pending);
      expect(otherProfile[0]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
      const backOnA = await liveTurns(stale, [{ reply: urlAt('a2', 'https://two.dev') }], pending);
      expect(backOnA[0]?.keys.get('0,0')?.settings).toEqual(one);
    });

    it('a new chat forgets a stored edit once disk shows anything else there', async () => {
      const { pending, path } = fileStore();
      await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
      const nextPage: BoardKey = { uuid: 'com.elgato.streamdeck.page.next', settings: {}, label: 'Next Page' };
      const native = page({ '0,0': nextPage, '1,0': empty });
      const { io } = makeIo([]); // opens and quits, so only the start can forget it
      await runChatSetup({ io, ask: async () => null, board: native, readBoard: () => native, configPath: '/x', pending });
      const stored = JSON.parse(readFileSync(path, 'utf8')) as { edits: unknown[] };
      expect(stored.edits).toEqual([]);
      const seen = await liveTurns(stale, [{ reply: urlAt('a2', 'https://two.dev') }], pending);
      expect(seen[0]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
    });

    it('a restart in a later chat forgets every stored edit on that page', async () => {
      const { pending } = fileStore();
      await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
      // Stream Deck lost the a1 edit (a crash), so disk stays stale and only the restart can forget it.
      const text = '{"layout":{"deck":"xl","keys":[{"coord":"a2","type":"text","text":"note"}]}}';
      await liveTurns(stale, [{ reply: text, outcome: 'restarted' }], pending);
      const seen = await liveTurns(stale, [{ reply: urlAt('a2', 'https://two.dev') }], pending);
      expect(seen[0]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
    });

    it('a restart that was called off still forgets the stored edits on that page, and wrote nothing', async () => {
      const { pending } = fileStore();
      await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
      // Stream Deck lost the a1 edit: the restart finds a1 empty on disk, not one.dev, and writes nothing.
      const { io, said } = makeIo(['change it', 'y']);
      const planned: Array<BoardLayout | null> = [];
      await runChatSetup({
        io,
        ask: async () => urlAt('a1', 'https://q.dev'),
        onLayout: async (_p, t) => {
          planned.push(t.board);
          return 'reloaded';
        },
        board: stale,
        readBoard: () => stale,
        configPath: '/x',
        pending,
      });
      expect(planned[0]?.keys.get('0,0')?.settings).toEqual(one);
      expect(said).toContain('Nothing written.');
      const seen = await liveTurns(stale, [{ reply: urlAt('a1', 'https://q.dev') }], pending);
      expect(seen[0]?.keys.get('0,0')?.settings).toEqual({ kind: 'empty' });
    });

    it('counts the hour from the latest live edit to a key', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = 1_700_000_000_000;
        const { path } = fileStore();
        // Each chat has its own store on the shared file, as each `jetstream chat` run does, and has quit
        // before the next one starts: only then does the hour count.
        const quitChat = (): PendingStore => pendingStore(path, () => Date.now(), () => false);
        vi.setSystemTime(start);
        await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], quitChat());
        vi.setSystemTime(start + 50 * 60_000);
        await liveTurns(stale, [{ reply: urlAt('a1', 'https://two.dev') }], quitChat());
        vi.setSystemTime(start + 61 * 60_000);
        const seen = await liveTurns(stale, [{ reply: urlAt('a2', 'https://x.dev') }], quitChat());
        expect(seen[0]?.keys.get('0,0')?.settings).toEqual({ kind: 'url', url: 'https://two.dev' });
      } finally {
        vi.useRealTimers();
      }
    });

    describe('when Stream Deck lost an earlier chat\'s live edit', () => {
      const X = { kind: 'url', url: 'https://x.dev' };
      const move = '{"layout":{"deck":"xl","keys":[{"coord":"a2","type":"open-url","url":"https://x.dev"},{"coord":"a1","type":"slot"}]}}';

      it('a live move onto that key never clears the source, and the next request moves it', async () => {
        const disk = page({ '0,0': slotKey(X), '1,0': empty });
        const { pending } = fileStore();
        // Chat 1 copies X to a2 live. Stream Deck then crashes before saving and reloads a2 empty from disk.
        await liveTurns(disk, [{ reply: urlAt('a2', 'https://x.dev') }], pending);
        const deck = fakeDeck({ a1: X, a2: { kind: 'empty' } });
        const outcomes: ApplyOutcome[] = [];
        const { io } = makeIo(['move a1 to a2', 'y', 'move a1 to a2', 'y']);
        await runChatSetup({
          io,
          ask: async () => move,
          onLayout: applyTo(deck, outcomes),
          board: disk,
          readBoard: () => disk,
          configPath: '/x',
          pending,
        });
        // The plan saw X laid over a2, so it sent a2 again first and stopped at its 409 with X still on a1.
        expect(deck.sent[0]).toEqual({ coord: 'a2', ...X, expect: X, deck: 'xl' });
        expect(deck.sent.filter((body) => body.coord === 'a1')).toHaveLength(1);
        // That 409 forgot the lost edit, so the second request planned against disk and moved X.
        expect(outcomes).toEqual(['declined', 'live']);
        expect(deck.held).toEqual({ a1: { kind: 'empty' }, a2: X });
      });

      it('a restart write of a move onto that key is called off', async () => {
        const disk = page({ '0,0': slotKey(X), '1,0': empty });
        const { pending } = fileStore();
        await liveTurns(disk, [{ reply: urlAt('a2', 'https://x.dev') }], pending);
        const deck = fakeDeck({ a1: X, a2: { kind: 'empty' } });
        const outcomes: ApplyOutcome[] = [];
        const { io } = makeIo(['move a1 to a2', 'y']);
        const onLayout = applyTo(deck, outcomes, { pluginAlive: async () => false, confirm: async () => true });
        await runChatSetup({ io, ask: async () => move, onLayout, board: disk, readBoard: () => disk, configPath: '/x', pending });
        expect(outcomes).toEqual(['reloaded']); // a2 is empty on disk, not the X the plan saw, so nothing is written
      });

      it('asking for that edit again is not "already set": it costs one 409, then applies', async () => {
        const { pending } = fileStore();
        await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
        const deck = fakeDeck({ a1: { kind: 'empty' }, a2: { kind: 'empty' } });
        const outcomes: ApplyOutcome[] = [];
        const { io, said } = makeIo(['set a1', 'y', 'set a1', 'y']);
        await runChatSetup({
          io,
          ask: async () => urlAt('a1', 'https://one.dev'),
          onLayout: applyTo(deck, outcomes),
          board: stale,
          readBoard: () => stale,
          configPath: '/x',
          pending,
        });
        expect(said).not.toContain('\nAlready set, nothing to change.');
        expect(outcomes).toEqual(['declined', 'live']);
        expect(deck.held.a1).toEqual(one);
      });

      it('a 409 keeps a newer edit another chat stored at that key since the plan', async () => {
        const { pending, path } = fileStore();
        await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
        const three: PendingEdit = {
          placement: { column: 0, row: 0, uuid: SLOT, name: 'Slot', settings: { kind: 'url', url: 'https://three.dev' } },
          before: [{ kind: 'empty' }],
          at: Date.now(),
          pid: process.pid + 1, // another chat
        };
        const { io } = makeIo(['set a1', 'y']);
        await runChatSetup({
          io,
          ask: async () => urlAt('a1', 'https://two.dev'),
          onLayout: async (_p, t) => {
            // Another chat set a1 live after this plan was made, so the plugin refuses this chat's edit.
            pendingStore(path).save(stale, new Map([['0,0', three]]));
            t.onConflict(['0,0']);
            return 'declined';
          },
          board: stale,
          readBoard: () => stale,
          configPath: '/x',
          pending,
        });
        expect(pendingStore(path).load(stale).get('0,0')).toEqual(three);
      });

      it('a 409 keeps a newer edit another chat stored since the plan, even with the same settings', async () => {
        const { pending, path } = fileStore();
        await liveTurns(stale, [{ reply: urlAt('a1', 'https://one.dev') }], pending);
        const planned = pendingStore(path).load(stale).get('0,0')!;
        // Another chat put the same key back live later: same settings, a newer edit.
        const newer: PendingEdit = { ...planned, at: planned.at + 1_000, pid: process.pid + 1 };
        const { io } = makeIo(['set a1', 'y']);
        await runChatSetup({
          io,
          ask: async () => urlAt('a1', 'https://two.dev'),
          onLayout: async (_p, t) => {
            pendingStore(path, Date.now, () => true).save(stale, new Map([['0,0', newer]]));
            t.onConflict(['0,0']);
            return 'declined';
          },
          board: stale,
          readBoard: () => stale,
          configPath: '/x',
          pending,
        });
        expect(pendingStore(path, Date.now, () => true).load(stale).get('0,0')).toEqual(newer);
      });
    });
  });
});
