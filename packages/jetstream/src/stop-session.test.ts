import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopFlagPath, takeStopFlag } from '@pimmesz/jetstream-status';
import { stopSessions } from './stop-session';

describe('stopSessions', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { denied: true, flagged: false, stopped: 1 },
    { denied: false, flagged: true, stopped: 1 },
    { denied: true, flagged: true, stopped: 1 },
    { denied: false, flagged: false, stopped: 0 },
  ])('denied $denied, flagged $flagged counts $stopped', ({ denied, flagged, stopped }) => {
    const denyPending = vi.fn(() => denied);
    const writeFlag = vi.fn(() => flagged);
    expect(stopSessions(['s1'], { denyPending, writeFlag })).toBe(stopped);
    // Both always run: a denied prompt does not spare the flag the next tool call needs.
    expect(denyPending).toHaveBeenCalledWith('s1');
    expect(writeFlag).toHaveBeenCalledWith('s1');
  });

  it('counts each session once across a list', () => {
    const stopped = stopSessions(['a', 'b', 'c'], {
      denyPending: (id) => id === 'a',
      writeFlag: (id) => id !== 'c',
    });
    expect(stopped).toBe(2);
  });

  it('the default writer leaves a 0600 flag that the stop gate consumes', () => {
    const home = mkdtempSync(join(tmpdir(), 'js-stop-session-'));
    vi.stubEnv('HOME', home);
    expect(stopSessions(['sess-flag'])).toBe(1);
    const path = stopFlagPath('sess-flag');
    expect(path?.startsWith(home)).toBe(true);
    expect(statSync(path ?? '').mode & 0o777).toBe(0o600);
    expect(takeStopFlag('sess-flag')).toBe(true);
    expect(stopSessions(['../escape'])).toBe(0); // an id that could leave the flag dir writes nothing
  });
});
