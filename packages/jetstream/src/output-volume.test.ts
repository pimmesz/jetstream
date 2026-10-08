import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promisify } from 'node:util';

// A fake macOS output volume behind osascript: reads and writes each take a moment, like the real
// spawns, so two quick presses overlap unless the module serialises them.
const audio = vi.hoisted(() => ({ volume: 50 }));
vi.mock('node:child_process', () => {
  const later = <T>(value: () => T): Promise<T> => new Promise((r) => setTimeout(() => r(value()), 5));
  const execFile = (): void => {};
  Object.defineProperty(execFile, promisify.custom, {
    value: (_cmd: string, args: string[]) => {
      const script = args[1] ?? '';
      const set = /set volume output volume (\d+)/.exec(script);
      if (set) return later(() => ((audio.volume = Number(set[1])), { stdout: '' }));
      return later(() => ({ stdout: String(audio.volume) }));
    },
  });
  return { execFile };
});
vi.mock('node:fs', async (real) => ({ ...(await real<typeof import('node:fs')>()), existsSync: () => false }));

const { nudgeOutputVolume } = await import('./output-volume');

describe('nudgeOutputVolume', () => {
  const platform = process.platform;
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
  afterAll(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('two quick presses both count: the second reads the volume the first wrote', async () => {
    audio.volume = 50;
    const results = await Promise.all([nudgeOutputVolume(6), nudgeOutputVolume(6)]);
    expect(results).toEqual([true, true]);
    expect(audio.volume).toBe(62);
  });
});
