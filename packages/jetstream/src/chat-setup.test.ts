import { describe, it, expect, vi } from 'vitest';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import { clarifyingQuestion, parseProposal, runChatSetup } from './chat-setup';
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
});

/** Scripted IO: queued answers to `ask`, captured `say` lines. */
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
