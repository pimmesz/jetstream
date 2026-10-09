import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STOP_OUTPUT, runStopGate, stopFlagDir, stopFlagPath, takeStopFlag } from './stop-flag';

/** The gate's I/O around a throwaway home, so the real flag store is used without touching ~. */
function gate(stdin: string) {
  const home = mkdtempSync(join(tmpdir(), 'js-gate-'));
  const take = vi.fn((sessionId: string) => takeStopFlag(sessionId, Date.now(), home));
  const write = vi.fn((_output: string) => {});
  const plant = (sessionId: string): void => {
    mkdirSync(stopFlagDir(home), { recursive: true });
    writeFileSync(stopFlagPath(sessionId, home) ?? '', '');
  };
  const run = (): Promise<void> => runStopGate({ readStdin: async () => stdin, take, write });
  return { take, write, plant, run };
}

describe('runStopGate (the PreToolUse stop gate)', () => {
  it('a fresh flag for the hook session prints STOP_OUTPUT exactly once', async () => {
    const g = gate(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-g' }));
    g.plant('sess-g');
    await g.run();
    await g.run(); // the flag is used up: the next tool call runs
    expect(g.write).toHaveBeenCalledTimes(1);
    expect(g.write).toHaveBeenCalledWith(STOP_OUTPUT);
  });

  it('prints nothing without a flag, or for another session', async () => {
    const g = gate(JSON.stringify({ session_id: 'sess-g' }));
    g.plant('sess-other');
    await g.run();
    expect(g.take).toHaveBeenCalledWith('sess-g');
    expect(g.write).not.toHaveBeenCalled();
  });

  it('prints nothing and reads no flag for bad input', async () => {
    for (const stdin of ['not json', '', 'null', JSON.stringify({ session_id: 42 })]) {
      const g = gate(stdin);
      await expect(g.run()).resolves.toBeUndefined();
      expect(g.take, stdin).not.toHaveBeenCalled();
      expect(g.write, stdin).not.toHaveBeenCalled();
    }
  });
});
