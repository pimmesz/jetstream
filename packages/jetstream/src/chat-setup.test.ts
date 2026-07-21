import { describe, it, expect, vi } from 'vitest';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import { clarifyingQuestion, parseProposal, runChatSetup, SETUP_SYSTEM } from './chat-setup';
import { KEY_TYPE_NAMES } from './layout';
import { DECK_MODELS } from './profile';

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
    const p = parseProposal('{"projects":[{"path":"/a"}],"settings":{"theme":"bogus","longPressMs":"x"}}');
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
    const p = parseProposal('{"layout":{"deck":"xl","keys":[{"coord":"a1","type":"usage"},{"coord":"a2","type":"nope"}]}}');
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

function makeIo(answers: string[]): { io: { ask: (q: string) => Promise<string>; say: (l: string) => void }; said: string[] } {
  const said: string[] = [];
  let i = 0;
  return { io: { ask: async () => answers[i++] ?? '', say: (l) => said.push(l) }, said };
}

describe('runChatSetup', () => {
  it('describe → propose → apply writes the validated fleet', async () => {
    const { io } = makeIo(['3 repos in /dev', 'y']);
    const replies = ['{"projects":[{"name":"Falcon","path":"/dev/falcon"}]}'];
    let r = 0;
    const write = vi.fn();
    const code = await runChatSetup({ io, ask: async () => replies[r++] ?? null, write, configPath: '/tmp/p.json' });
    expect(code).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toHaveLength(1);
  });

  it('runs onWritten with the written fleet after applying (the layout hook)', async () => {
    const { io } = makeIo(['3 repos in /dev', 'y']);
    const write = vi.fn();
    const onWritten = vi.fn(async (_projects: ProjectConfig[]) => {});
    const code = await runChatSetup({
      io,
      ask: async () => '{"projects":[{"name":"Falcon","path":"/dev/falcon"},{"name":"Api","path":"/dev/api"}]}',
      write,
      onWritten,
      configPath: '/tmp/p.json',
    });
    expect(code).toBe(0);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(onWritten.mock.calls[0]![0].map((p) => p.name)).toEqual(['Falcon', 'Api']);
  });

  it('refuses a PARTIAL layout instead of applying a destructive move (a dropped key would delete a source)', async () => {
    const { io, said } = makeIo(['move things around', 'cancel']);
    const onLayout = vi.fn(async () => {});
    // usage resolves at d1, but the unknown "nope" at d2 is dropped → applying would clear/overwrite
    // without placing everything the model intended. The flow must refuse, not apply the remainder.
    const reply = '{"layout":{"deck":"xl","keys":[{"coord":"d2","type":"nope"},{"coord":"d1","type":"usage"}]}}';
    let r = 0;
    const replies = [reply];
    const code = await runChatSetup({ io, ask: async () => replies[r++] ?? null, onLayout, configPath: '/x' });
    expect(code).toBe(0);
    expect(onLayout).not.toHaveBeenCalled(); // a partial layout is never applied
    expect(said.some((l) => /NOT applying/.test(l))).toBe(true);
  });

  it('a clarifying question loops, then applies on the next turn', async () => {
    const { io, said } = makeIo(['I have repos', 'in /dev', 'y']);
    const replies = ['QUESTION: where are they?', '{"projects":[{"path":"/dev/a"}]}'];
    let r = 0;
    const write = vi.fn();
    const code = await runChatSetup({ io, ask: async () => replies[r++] ?? null, write, configPath: '/x' });
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

  it('an unavailable agent exits 1 without writing', async () => {
    const { io, said } = makeIo(['describe my repos']);
    const write = vi.fn();
    const code = await runChatSetup({ io, ask: async () => null, write });
    expect(code).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(said.some((l) => /claude.*installed/i.test(l))).toBe(true);
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
});
