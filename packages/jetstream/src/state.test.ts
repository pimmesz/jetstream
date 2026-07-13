import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { Board } from './state';

// Each Board checkpoints to disk; give every test its own temp file so runs stay hermetic
// (never touch the real ~/.jetstream) and independent.
const tmpDirs: string[] = [];
const tmpFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-board-'));
  tmpDirs.push(dir);
  return join(dir, 'board-state.json');
};
const makeBoard = (): Board => new Board(tmpFile());
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('Board', () => {
  it('maps hook events onto registered project keys', () => {
    const board = makeBoard();
    board.setProject('key-1', { name: 'falcon', path: '/Users/me/falcon' });
    board.dispatch({ event: 'UserPromptSubmit', cwd: '/Users/me/falcon/src', sessionId: 's1', at: 5 });
    expect(board.byProject()['key-1']).toEqual({ status: 'working', since: 5 });
  });

  it('attention lists waiting projects and clears on key removal', () => {
    const board = makeBoard();
    board.setProject('key-1', { name: 'falcon', path: '/Users/me/falcon' });
    board.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 's1', at: 5 });
    expect(board.attention().map((p) => p.name)).toEqual(['falcon']);
    board.removeProject('key-1');
    expect(board.attention()).toEqual([]);
  });

  it('notifies subscribers on dispatch and settings changes', () => {
    const board = makeBoard();
    let calls = 0;
    board.subscribe(() => calls++);
    board.setProject('k', { name: 'x', path: '/x' });
    board.dispatch({ event: 'Stop', cwd: '/x', sessionId: 's', at: 1 });
    expect(calls).toBe(2);
  });

  it('seeds a fleet that feeds byProject/attention without a placed key', () => {
    const board = makeBoard();
    board.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
    board.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 's1', at: 5 });
    expect(board.byProject()['falcon']).toEqual({ status: 'needsInput', since: 5 });
    expect(board.attention().map((p) => p.name)).toEqual(['Falcon']);
  });

  it('lets a placed key override a seeded entry by id, and restores it on removal', () => {
    const board = makeBoard();
    board.seed([{ id: 'x', name: 'Seed', path: '/seed' }]);
    board.setProject('x', { name: 'Deck', path: '/deck' });
    expect(board.projects()).toEqual([{ id: 'x', name: 'Deck', path: '/deck' }]); // deck wins by id
    board.removeProject('x');
    expect(board.projects()).toEqual([{ id: 'x', name: 'Seed', path: '/seed' }]); // seeded restored
  });

  it('a placed key owns its repo status even when projects.json seeds the same path (no gray key)', () => {
    const board = makeBoard();
    board.seed([
      { id: 'afterburner', name: 'afterburner', path: '/U/afterburner' },
      { id: 'grantbot', name: 'grantbot', path: '/U/grantbot' }, // keyless: seed still covers it
    ]);
    board.setProject('action-1', { name: 'afterburner', path: '/U/afterburner' }); // placed key
    board.dispatch({ event: 'UserPromptSubmit', cwd: '/U/afterburner', sessionId: 's1', at: 1 });

    const by = board.byProject();
    // The key (keyed by its ACTION id) reflects the live status — the earlier bug attached it
    // to the seed's config id, leaving the key's own id 'none' and the key gray.
    expect(by['action-1']).toEqual({ status: 'working', since: 1 });
    expect(by['afterburner']).toBeUndefined(); // the duplicate seed is suppressed for a keyed repo

    // A keyless seeded repo is still covered for the Fleet / Attention roll-ups.
    board.dispatch({ event: 'Notification', cwd: '/U/grantbot', sessionId: 's2', at: 2 });
    expect(board.byProject()['grantbot']).toEqual({ status: 'needsInput', since: 2 });
  });

  it('discovery fills hook-silent projects by CPU (active→working, idle→idle) and never overrides a hook state', () => {
    const board = makeBoard();
    board.setProject('k-jarvis', { name: 'JARVIS', path: '/U/JARVIS' });
    board.setProject('k-headless', { name: 'headless', path: '/U/headless' });
    board.setProject('k-ab', { name: 'afterburner', path: '/U/afterburner' });
    // afterburner has a hook-reported status; JARVIS/headless have none (events predate this instance).
    board.dispatch({ event: 'Stop', cwd: '/U/afterburner', sessionId: 's1', at: 1 });

    board.setDiscovered([
      { pid: 100, cwd: '/U/JARVIS', active: true }, // burning CPU → working (pink)
      { pid: 150, cwd: '/U/headless', active: false }, // idle at a prompt → idle (blue), not a false 'working'
      { pid: 200, cwd: '/U/afterburner', active: true }, // hooks already said 'done' → NOT overridden
      { pid: 300, cwd: '/U/elsewhere', active: true }, // matches no project → ignored
    ]);

    const by = board.byProject();
    expect(by['k-jarvis']).toEqual({ status: 'working' }); // active session shows working
    expect(by['k-headless']).toEqual({ status: 'idle' }); // idle session shows idle, not working
    expect(by['k-ab']).toEqual({ status: 'done', since: 1 }); // hook state wins over discovery
  });

  describe('restart persistence (restore reconciled against live sessions by cwd)', () => {
    const FLEET = [
      { id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' },
      { id: 'osprey', name: 'Osprey', path: '/Users/me/osprey' },
    ];

    it('re-shows a session still running in its repo and drops one whose process is gone', async () => {
      const file = tmpFile();
      const before = new Board(file);
      before.seed(FLEET);
      before.notePid('s-alive', 4242, '/Users/me/falcon');
      before.dispatch({ event: 'UserPromptSubmit', cwd: '/Users/me/falcon', sessionId: 's-alive', at: 1 });
      before.notePid('s-dead', 4243, '/Users/me/osprey');
      before.dispatch({ event: 'UserPromptSubmit', cwd: '/Users/me/osprey', sessionId: 's-dead', at: 2 });

      // A fresh Board (a restart) reads the same checkpoint; only falcon has a live session now,
      // running under a NEW pid (the old 4242 is gone / possibly recycled by another repo).
      const after = new Board(file);
      after.seed(FLEET);
      await after.restore(async () => [{ pid: 9999, cwd: '/Users/me/falcon', active: true }]);

      expect(after.byProject()['falcon']).toEqual({ status: 'working', since: 1 }); // survived by cwd
      expect(after.byProject()['osprey']).toEqual({ status: 'none' }); // no live session → gray
      // interrupt targets the LIVE pid, never the stale/recycled 4242
      expect(after.pidsForProject('falcon')).toEqual([9999]);
      expect(after.pidsForProject('osprey')).toEqual([]);
    });

    it('merges under live hook events that arrived during the scan (never clobbers them)', async () => {
      const file = tmpFile();
      const before = new Board(file);
      before.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      before.dispatch({ event: 'UserPromptSubmit', cwd: '/Users/me/falcon', sessionId: 's1', at: 1 }); // checkpoint: working

      const after = new Board(file);
      after.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      // A live hook lands (the session finished) BEFORE the async scan resolves:
      after.dispatch({ event: 'Stop', cwd: '/Users/me/falcon', sessionId: 's1', at: 5 }); // live: done
      await after.restore(async () => [{ pid: 9, cwd: '/Users/me/falcon', active: true }]);
      // the live 'done' must win over the checkpoint's stale 'working'
      expect(after.byProject()['falcon']).toEqual({ status: 'done', since: 5 });
    });

    it('does not resurrect a session a live SessionEnd removed DURING the scan', async () => {
      const file = tmpFile();
      const before = new Board(file);
      before.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      before.notePid('s1', 4242, '/Users/me/falcon');
      before.dispatch({ event: 'UserPromptSubmit', cwd: '/Users/me/falcon', sessionId: 's1', at: 1 }); // checkpoint: working

      const after = new Board(file);
      after.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      await after.restore(async () => {
        // the session ends while the async scan is still resolving, and discovery still
        // momentarily sees the process alive at that cwd (the resurrection trap)
        after.dispatch({ event: 'SessionEnd', cwd: '/Users/me/falcon', sessionId: 's1', at: 5 });
        return [{ pid: 9, cwd: '/Users/me/falcon', active: true }];
      });
      expect(after.byProject()['falcon']).toEqual({ status: 'none' }); // gray, not resurrected 'working'
      expect(after.pidsForProject('falcon')).toEqual([]); // no stale PID for interrupt to target
    });

    it('keeps a still-live checkpoint session when a DIFFERENT session in the repo emits mid-scan', async () => {
      // Suppression keys on session id, not cwd: a new session's event must NOT hide a still-
      // relevant checkpoint session for the same repo (here one blocked needing input).
      const file = tmpFile();
      const before = new Board(file);
      before.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      before.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 's1', at: 1 }); // checkpoint: needsInput

      const after = new Board(file);
      after.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      await after.restore(async () => {
        // a different session finishes mid-scan; it must not suppress s1's restore
        after.dispatch({ event: 'Stop', cwd: '/Users/me/falcon', sessionId: 's2', at: 5 });
        return [{ pid: 9, cwd: '/Users/me/falcon', active: true }];
      });
      // s1 (needsInput, rank 4) still wins over s2 (done, rank 2) — the attention signal survives
      expect(after.byProject()['falcon']).toEqual({ status: 'needsInput', since: 1 });
    });

    it('restore is a safe no-op with no checkpoint', async () => {
      const board = new Board(tmpFile());
      board.seed([{ id: 'x', name: 'X', path: '/x' }]);
      await expect(board.restore(async () => [])).resolves.toBeUndefined();
      expect(board.byProject()['x']).toEqual({ status: 'none' });
    });

    it('restore ignores malformed checkpoint entries instead of crashing startup', async () => {
      const file = tmpFile();
      // a null session value and a cwd-less one must be skipped, not dereferenced
      writeFileSync(file, '{"state":{"sessions":{"bad":null,"cwdless":{"status":"working","since":1}}}}');
      const board = new Board(file);
      board.seed([{ id: 'x', name: 'X', path: '/x' }]);
      await expect(
        board.restore(async () => [{ pid: 1, cwd: '/x', active: true }]),
      ).resolves.toBeUndefined();
      expect(board.byProject()['x']).toEqual({ status: 'none' }); // nothing restored, no throw
    });

    it('does not restore an ambiguous cwd (two persisted sessions in one repo)', async () => {
      const file = tmpFile();
      const before = new Board(file);
      before.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      // Two sessions in the same repo — one now dead (needsInput), one live (idle).
      before.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 'dead', at: 1 });
      before.dispatch({ event: 'SessionStart', cwd: '/Users/me/falcon', sessionId: 'live', at: 2 });

      const after = new Board(file);
      after.seed([{ id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' }]);
      await after.restore(async () => [{ pid: 7, cwd: '/Users/me/falcon', active: false }]);
      // Can't tell which persisted session is the live one → restore neither (no resurrected needsInput).
      expect(after.byProject()['falcon']).toEqual({ status: 'none' });
    });
  });

  describe('discovery CPU cross-check (workflow-wait)', () => {
    const falcon = { id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' };
    const busy = [{ pid: 9, cwd: '/Users/me/falcon', active: true }];

    it('upgrades a Stop→done project to working when the repo stays busy (the green case)', () => {
      const board = new Board(tmpFile());
      board.seed([falcon]);
      board.dispatch({ event: 'Stop', cwd: '/Users/me/falcon', sessionId: 's1', at: 1_000 }); // hook: done
      board.setDiscovered(busy, 1_000); // repo busy (a workflow's subagents), first seen at t=1000
      expect(board.byProject(1_000)['falcon']).toEqual({ status: 'done', since: 1_000 }); // not yet sustained
      board.setDiscovered(busy, 14_000); // still busy 13s later — past the 12s sustained threshold
      expect(board.byProject(14_000)['falcon']).toEqual({ status: 'working', since: 1_000 });
    });

    it('upgrades an idle_prompt→needsInput project to working when the repo stays busy (the amber case)', () => {
      const board = new Board(tmpFile());
      board.seed([falcon]);
      board.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 's1', at: 1_000 }); // needsInput
      board.setDiscovered(busy, 1_000);
      board.setDiscovered(busy, 14_000);
      expect(board.byProject(14_000)['falcon']?.status).toBe('working');
    });

    it('does NOT flicker a genuine done to working on a brief post-Stop CPU spike', () => {
      const board = new Board(tmpFile());
      board.seed([falcon]);
      board.dispatch({ event: 'Stop', cwd: '/Users/me/falcon', sessionId: 's1', at: 1_000 });
      board.setDiscovered(busy, 1_000); // reads active briefly (decaying CPU)...
      board.setDiscovered([], 6_000); // ...then quiet by the next poll — never sustained
      expect(board.byProject(20_000)['falcon']).toEqual({ status: 'done', since: 1_000 });
    });

    it('leaves a quiet needsInput as the doorbell (a real permission wait is CPU-idle)', () => {
      const board = new Board(tmpFile());
      board.seed([falcon]);
      board.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 's1', at: 1_000 });
      board.setDiscovered([], 1_000); // no busy process → a genuine wait-on-you
      expect(board.byProject(20_000)['falcon']?.status).toBe('needsInput');
    });
  });
});
