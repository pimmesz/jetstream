import { describe, it, expect, vi } from 'vitest';
import { clarifyingQuestion, parseProposal, runChatSetup } from './chat-setup';

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
