import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  STOP_FLAG_TTL_MS,
  STOP_OUTPUT,
  clearStopFlagOnTurnEnd,
  stopFlagDir,
  stopFlagPath,
  takeStopFlag,
} from './stop-flag';
import { activeSessions, initialState, reduce, type HookEvent } from './index';

function plant(home: string, sessionId: string, ageMs = 0): string {
  mkdirSync(stopFlagDir(home), { recursive: true });
  const path = stopFlagPath(sessionId, home)!;
  writeFileSync(path, '');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

describe('stop flags', () => {
  it('a fresh flag stops exactly once, then is gone', () => {
    const home = mkdtempSync(join(tmpdir(), 'js-stop-'));
    const path = plant(home, 'sess-1');
    expect(takeStopFlag('sess-1', Date.now(), home)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(takeStopFlag('sess-1', Date.now(), home)).toBe(false);
  });

  it('a stale flag is removed without stopping the new turn', () => {
    const home = mkdtempSync(join(tmpdir(), 'js-stop-'));
    const path = plant(home, 'sess-2', STOP_FLAG_TTL_MS + 60_000);
    expect(takeStopFlag('sess-2', Date.now(), home)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('the lifecycle hook drops a leftover flag when the turn is over, with no plugin involved', () => {
    const home = mkdtempSync(join(tmpdir(), 'js-stop-'));
    const path = plant(home, 'sess-3');
    clearStopFlagOnTurnEnd('PreToolUse', 'sess-3', home); // mid-turn: the stop still stands
    expect(existsSync(path)).toBe(true);
    clearStopFlagOnTurnEnd('UserPromptSubmit', 'sess-3', home);
    expect(existsSync(path)).toBe(false);
    expect(() => clearStopFlagOnTurnEnd('Stop', 'sess-3', home)).not.toThrow(); // nothing left
    expect(() => clearStopFlagOnTurnEnd('Stop', '../x', home)).not.toThrow();
  });

  it('the gate output tells Claude to stop processing, with a reason to show', () => {
    expect(JSON.parse(STOP_OUTPUT)).toEqual({ continue: false, stopReason: expect.any(String) });
  });

  it('a session id that could escape the flag directory is refused', () => {
    expect(stopFlagPath('../../etc/passwd', '/h')).toBeUndefined();
    expect(stopFlagPath('', '/h')).toBeUndefined();
    expect(takeStopFlag('../x', Date.now(), '/h')).toBe(false);
  });
});

describe('activeSessions', () => {
  const projects = [{ id: 'falcon', name: 'Falcon', path: '/me/falcon' }];
  const ev = (over: Partial<HookEvent>): HookEvent => ({
    event: 'UserPromptSubmit',
    cwd: '/me/falcon',
    sessionId: 's1',
    at: 1,
    ...over,
  });

  it('lists working and prompt-blocked sessions, not finished ones', () => {
    let s = reduce(initialState(), ev({ sessionId: 'w' }));
    s = reduce(s, ev({ sessionId: 'n', event: 'Notification', notificationType: 'permission_prompt' }));
    s = reduce(s, ev({ sessionId: 'd', event: 'Stop' }));
    s = reduce(s, ev({ sessionId: 'o', cwd: '/elsewhere' }));
    expect(activeSessions(s, projects, 'falcon', 2).sort()).toEqual(['n', 'w']);
    expect(activeSessions(s, projects, undefined, 2).sort()).toEqual(['n', 'o', 'w']);
  });
});
