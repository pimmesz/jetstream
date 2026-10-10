import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { backupProfile, overlayActions, processSignals, readCurrentPage, writeInPlace, type AppControl, type SignalSource, type StoredAction } from './profile-store';
import { readForeignCatalog } from './plugin-catalog';
import type { Placement } from './layout';
import { applyLayout, type ApplyOutcome } from './chat-apply';
import { readBoardLayout } from './board-layout';

const STATE = { FontSize: 18, ShowTitle: true };

/** A profile laid out the way Stream Deck 7 stores one: lower-case page ids in the manifest,
 * upper-case page directories, and a second page that must never be touched. */
function makeProfile(root: string, actions: Record<string, StoredAction>): string {
  const dir = join(root, 'CF17C203.sdProfile');
  mkdirSync(join(dir, 'Profiles', 'AAAA-1111'), { recursive: true });
  mkdirSync(join(dir, 'Profiles', 'BBBB-2222'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      Device: { Model: '20GAT9902', UUID: 'dev' },
      Name: 'Jetstream',
      Pages: { Current: 'aaaa-1111', Default: 'bbbb-2222', Pages: ['aaaa-1111'] },
      Version: '3.0',
    }),
  );
  writeFileSync(
    join(dir, 'Profiles', 'AAAA-1111', 'manifest.json'),
    JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: actions }], Icon: '', Name: '' }),
  );
  writeFileSync(
    join(dir, 'Profiles', 'BBBB-2222', 'manifest.json'),
    JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: {} }], Icon: '', Name: '' }),
  );
  return dir;
}

const slotAction = (settings: Record<string, unknown>): StoredAction => ({
  ActionID: 'keep-me',
  LinkedTitle: false,
  Name: 'old',
  Plugin: { Name: 'Jetstream', UUID: 'gg.pim.jetstream', Version: '3.0.3.0' },
  Resources: null,
  Settings: settings,
  State: 0,
  States: [{ ...STATE, TitleColor: '#123456' }],
  UUID: 'gg.pim.jetstream.slot',
});

const placement = (over: Partial<Placement>): Placement => ({
  column: 0,
  row: 0,
  uuid: 'gg.pim.jetstream.slot',
  name: 'New',
  settings: { kind: 'empty' },
  ...over,
});

describe('readCurrentPage', () => {
  it('reads the page the deck shows, not every page', () => {
    const dir = makeProfile(mkdtempSync(join(tmpdir(), 'js-store-')), { '0,0': slotAction({ kind: 'app' }) });
    const page = readCurrentPage(dir);
    expect(page?.manifestPath).toContain('AAAA-1111');
    expect(Object.keys(page?.actions ?? {})).toEqual(['0,0']);
  });

  it('refuses a profile in a format it does not know', () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ Version: '2.0', Pages: {} }));
    expect(readCurrentPage(dir)).toBeNull();
  });
});

describe('overlayActions', () => {
  it('a same-type edit keeps the key identity and title style, changing only settings and name', () => {
    const next = overlayActions({ '0,0': slotAction({ kind: 'app' }) }, [placement({ settings: { kind: 'url', url: 'https://x' } })], {
      jetstreamVersion: '3.1.0.0',
    });
    expect(next['0,0']).toMatchObject({
      ActionID: 'keep-me',
      Name: 'New',
      Settings: { kind: 'url', url: 'https://x' },
      States: [{ ...STATE, TitleColor: '#123456' }],
    });
  });

  it('a copied third-party key keeps its plugin block and both of its states', () => {
    const plugin = { Name: 'Philips Hue', UUID: 'com.elgato.philipshue', Version: '2.2.1.15' };
    const next = overlayActions(
      {},
      [placement({ column: 5, row: 3, uuid: 'com.elgato.philipshue.power', settings: { id: 'l' }, source: { plugin, states: [STATE, {}] } })],
      { jetstreamVersion: '3.1.0.0', newId: () => 'fresh' },
    );
    expect(next['5,3']).toMatchObject({ ActionID: 'fresh', Plugin: plugin, States: [STATE, {}], UUID: 'com.elgato.philipshue.power' });
  });
});

describe('writeInPlace', () => {
  function fakeApp(): AppControl & { log: string[] } {
    let running = true;
    const log: string[] = [];
    return {
      log,
      isRunning: () => running,
      quit: () => {
        log.push('quit');
        running = false;
      },
      launch: () => void log.push('launch'),
      sleep: async () => {},
    };
  }

  it('backs up, quits, writes only the current page, and relaunches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, { '0,0': slotAction({ kind: 'app' }) });
    const other = readFileSync(join(dir, 'Profiles', 'BBBB-2222', 'manifest.json'), 'utf8');
    const app = fakeApp();
    const result = await writeInPlace(dir, [placement({ column: 1, row: 0, settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'write.lock'),
      changedSincePlan: () => [],
    });
    expect(result.ok).toBe(true);
    expect(app.log).toEqual(['quit', 'launch']);
    const page = readCurrentPage(dir)!;
    expect(Object.keys(page.actions).sort()).toEqual(['0,0', '1,0']);
    expect(readFileSync(join(dir, 'Profiles', 'BBBB-2222', 'manifest.json'), 'utf8')).toBe(other);
    expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  });

  it('writes the page it was given even when another page became current during the quit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const manifest = join(dir, 'manifest.json');
    const app = fakeApp();
    app.quit = () => {
      // The user flipped to page B before quitting; Stream Deck saves that as current on the way out.
      const top = JSON.parse(readFileSync(manifest, 'utf8'));
      top.Pages = { ...top.Pages, Current: 'bbbb-2222', Pages: ['aaaa-1111', 'bbbb-2222'] };
      writeFileSync(manifest, JSON.stringify(top));
      app.isRunning = () => false;
    };
    await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'write.lock'),
      pageId: 'aaaa-1111',
      changedSincePlan: () => [],
    });
    expect(Object.keys(readCurrentPage(dir, 'aaaa-1111')!.actions)).toEqual(['0,0']);
    expect(readCurrentPage(dir, 'bbbb-2222')!.actions).toEqual({});
  });

  it('backs up what Stream Deck saved on the way out, not the older file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, { '0,0': slotAction({ kind: 'app', app: '/old.app' }) });
    const page = join(dir, 'Profiles', 'AAAA-1111', 'manifest.json');
    const app = fakeApp();
    app.quit = () => {
      writeFileSync(page, JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: { '0,0': slotAction({ kind: 'app', app: '/flushed.app' }) } }] }));
      app.isRunning = () => false;
    };
    await writeInPlace(dir, [placement({ settings: { kind: 'empty' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'write.lock'),
      changedSincePlan: () => [],
    });
    const [backup] = readdirSync(join(root, 'backups'));
    expect(readFileSync(join(root, 'backups', backup!, 'Profiles', 'AAAA-1111', 'manifest.json'), 'utf8')).toContain('/flushed.app');
  });

  it('relaunches Stream Deck even when it would not quit in time, and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const app = { ...fakeApp(), isRunning: () => true };
    const launched: string[] = [];
    app.launch = () => void launched.push('launch');
    const result = await writeInPlace(dir, [placement({})], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'write.lock'),
      quitTimeoutMs: 0,
      changedSincePlan: () => [],
    });
    expect(result.ok).toBe(false);
    expect(launched).toEqual(['launch']);
    expect(readCurrentPage(dir)?.actions).toEqual({});
  });

  it('names an open Stream Deck dialog when the app refuses to quit, and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const app = fakeApp();
    app.quit = () => {
      app.log.push('quit');
      throw new Error('Command failed: osascript\n0:35: execution error: Elgato Stream Deck got an error: User cancelled. (-128)\n');
    };
    const result = await writeInPlace(dir, [placement({})], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'write.lock'),
      changedSincePlan: () => [],
    });
    expect(result).toEqual({
      ok: false,
      reason: 'Stream Deck refused to close, which usually means a dialog or its editor window is open. Close it, then send your request again',
    });
    expect(app.log).toEqual(['quit', 'launch']);
    expect(readCurrentPage(dir)?.actions).toEqual({});
  });

  /** A fake app whose quit saves `a1` the way Stream Deck saves its in-memory state on the way out. */
  function appSavingOnQuit(page: string, a1: StoredAction): AppControl & { log: string[] } {
    const app = fakeApp();
    app.quit = () => {
      app.log.push('quit');
      writeFileSync(page, JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: { '0,0': a1 } }] }));
      app.isRunning = () => false;
    };
    return app;
  }

  /** Put a Hue key at a1 through chat's restart route, with the real writer wired as `jetstream chat` wires it. */
  async function restartHueAtA1(root: string, app: AppControl): Promise<{ outcome: ApplyOutcome; said: string; lockPath: string }> {
    const lockPath = join(root, 'write.lock');
    const said: string[] = [];
    const hue: Placement = {
      column: 0,
      row: 0,
      uuid: 'com.elgato.philipshue.power',
      name: 'Desk lamp',
      settings: { id: 'l' },
      source: { plugin: { Name: 'Philips Hue', UUID: 'com.elgato.philipshue', Version: '2.2.1.15' }, states: [STATE, {}] },
    };
    const outcome = await applyLayout([hue], {
      say: (line) => void said.push(line),
      confirm: async () => true,
      board: readBoardLayout(root, []), // [] keeps it away from the real Stream Deck preferences
      pluginAlive: async () => true,
      sendSlot: async () => 200,
      writeInPlace: (profileDir, placements, pageId, changedSincePlan) =>
        writeInPlace(profileDir, placements, {
          ...(pageId ? { pageId } : {}),
          changedSincePlan,
          jetstreamVersion: '3.1.0.0',
          app,
          backupRoot: join(root, 'backups'),
          lockPath,
        }),
      importProfile: () => {
        throw new Error('a board was found, so nothing should be imported');
      },
    });
    return { outcome, said: said.join('\n'), lockPath };
  }

  it('a restart write changes nothing when Stream Deck saved a change to a planned key on the way out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, { '0,0': slotAction({ kind: 'app', app: '/A.app' }) });
    // An edit made on the deck after the preview, which Stream Deck only saves when it quits.
    const app = appSavingOnQuit(join(dir, 'Profiles', 'AAAA-1111', 'manifest.json'), slotAction({ kind: 'app', app: '/B.app' }));
    const { outcome, said, lockPath } = await restartHueAtA1(root, app);
    expect(outcome).toBe('reloaded');
    expect(readCurrentPage(dir)!.actions['0,0']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'app', app: '/B.app' } });
    expect(app.log).toEqual(['quit', 'launch']);
    expect(existsSync(lockPath)).toBe(false);
    expect(said).toContain('these keys changed since the plan was made: a1');
    expect(said).toContain('Send the request again');
  });

  it('a restart write still lands when the quit only saved what a rolled-back live edit left', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, { '0,0': slotAction({ kind: 'empty', color: '#e5484d' }) });
    // A rollback puts a styled spacer back without its colour; that is not a change made by someone else.
    const app = appSavingOnQuit(join(dir, 'Profiles', 'AAAA-1111', 'manifest.json'), slotAction({ kind: 'empty' }));
    const { outcome } = await restartHueAtA1(root, app);
    expect(outcome).toBe('restarted');
    expect(readCurrentPage(dir)!.actions['0,0']).toMatchObject({ UUID: 'com.elgato.philipshue.power', Settings: { id: 'l' } });
  });

  it('asks changedSincePlan about the page saved on the way out, under the lock, and writes nothing when it names a key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, { '0,0': slotAction({ kind: 'app', app: '/A.app' }) });
    const page = join(dir, 'Profiles', 'AAAA-1111', 'manifest.json');
    const app = appSavingOnQuit(page, slotAction({ kind: 'app', app: '/B.app' }));
    const lockPath = join(root, 'write.lock');
    // A backup an earlier real write left: only 5 are kept, so a write that is called off must not use one up.
    const earlier = 'CF17C203.sdProfile.2026-01-01T00-00-00-000Z';
    mkdirSync(join(root, 'backups', earlier), { recursive: true });
    const calls: Array<{ actions: Record<string, StoredAction>; isLocked: boolean; file: string }> = [];
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: (actions) => {
        calls.push({ actions, isLocked: existsSync(lockPath), file: readFileSync(page, 'utf8') });
        return ['a1'];
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actions['0,0']?.Settings).toEqual({ kind: 'app', app: '/B.app' });
    expect(calls[0]!.isLocked).toBe(true);
    expect(result).toMatchObject({ ok: false, changed: ['a1'] });
    expect(readFileSync(page, 'utf8')).toBe(calls[0]!.file); // the saved page, byte for byte
    expect(app.log).toEqual(['quit', 'launch']);
    expect(readdirSync(join(root, 'backups'))).toEqual([earlier]); // no backup taken
  });
});

describe('writeInPlace lock', () => {
  const app = (): AppControl => ({ isRunning: () => false, quit: () => {}, launch: () => {}, sleep: async () => {} });

  it('refuses while another writer holds the lock, and releases its own lock when done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    writeFileSync(lockPath, '999');
    const opts = { jetstreamVersion: '3.1.0.0', app: app(), backupRoot: join(root, 'backups'), lockPath, changedSincePlan: () => [] };
    const busy = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], opts);
    expect(busy).toMatchObject({ ok: false });
    expect(readCurrentPage(dir)?.actions).toEqual({}); // nothing written
    rmSync(lockPath);
    expect((await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], opts)).ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('never removes a lock it does not own, and reports an unwritable lock folder instead of throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const thief: AppControl = {
      ...app(),
      isRunning: () => true,
      quit: () => {
        writeFileSync(lockPath, 'another writer'); // a recoverer replaced our lock mid-write
        thief.isRunning = () => false;
      },
    };
    await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app: thief,
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => [],
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('another writer');
    writeFileSync(join(root, 'not-a-dir'), '');
    const blocked = await writeInPlace(dir, [placement({})], {
      jetstreamVersion: '3.1.0.0',
      app: app(),
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'not-a-dir', 'write.lock'),
      changedSincePlan: () => [],
    });
    expect(blocked).toMatchObject({ ok: false });
  });

  it('reports a lock left by a writer that died, with the file to delete, instead of taking it over', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    writeFileSync(lockPath, '999');
    const old = (Date.now() - 3 * 60_000) / 1000;
    utimesSync(lockPath, old, old);
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app: app(),
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => [],
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain(lockPath);
    expect(readCurrentPage(dir)?.actions).toEqual({}); // nothing written
  });
});

describe('backupProfile', () => {
  it('keeps the backups owner-only, tightening a root an older version left open', () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, { '0,0': slotAction({ kind: 'app' }) });
    const backupRoot = join(root, 'backups');
    mkdirSync(backupRoot);
    chmodSync(backupRoot, 0o755);
    const dest = backupProfile(dir, backupRoot);
    expect(statSync(backupRoot).mode & 0o777).toBe(0o700);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
  });
});

describe('writeInPlace signals', () => {
  /** A stand-in for the process's signals. Like a real one, a sent signal reaches its handlers only once
   * the loop's poll phase comes round (a nested setImmediate), never in the middle of synchronous code.
   * A signal sent while nothing listens takes the default action, which a real process does not survive. */
  function fakeSignals(log: string[], lockPath: string): SignalSource & { send: (s: NodeJS.Signals) => void; listening: () => number } {
    const handlers = new Map<NodeJS.Signals, Set<(s: NodeJS.Signals) => void>>();
    const held = (): string => (existsSync(lockPath) ? ' (lock still held)' : '');
    return {
      on: (signal, handler) => void handlers.set(signal, (handlers.get(signal) ?? new Set()).add(handler)),
      off: (signal, handler) => void handlers.get(signal)?.delete(handler),
      kill: (signal) => void log.push(`kill ${signal}${held()}`),
      send: (signal) => {
        if (!handlers.get(signal)?.size) return void log.push(`died of ${signal}${held()}`);
        setImmediate(() => setImmediate(() => handlers.get(signal)?.forEach((handler) => handler(signal))));
      },
      listening: () => [...handlers.values()].reduce((count, set) => count + set.size, 0),
    };
  }

  /** Stream Deck that never finishes quitting; `onSleep` runs at each poll of the quit-wait. */
  function stuckApp(log: string[], onSleep: () => void): AppControl & { sleeps: number } {
    const app = {
      sleeps: 0,
      isRunning: () => true,
      quit: () => void log.push('quit'),
      launch: () => void log.push('launch'),
      sleep: async () => {
        app.sleeps++;
        onSleep();
        // A real 250 ms sleep lets the poll phase pass, so a signal sent before it is heard by the end.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
    return app;
  }

  it('a signal during the quit-wait stops it, writes nothing, relaunches and frees the lock, then re-sends the signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    const app = stuckApp(log, () => signals.send('SIGINT'));
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath,
      quitTimeoutMs: 60_000,
      changedSincePlan: () => [],
      signals,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('SIGINT') });
    expect(app.sleeps).toBe(1); // the wait stopped at the signal, not at the 60 s deadline
    expect(log).toEqual(['quit', 'launch', 'kill SIGINT']); // re-sent only once the deck is back and the lock is free
    expect(signals.listening()).toBe(0);
    expect(readCurrentPage(dir)?.actions).toEqual({});
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('a second signal while one is deferred exits at once, before the relaunch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    const app = stuckApp(log, () => {
      signals.send('SIGINT');
      signals.send('SIGTERM');
    });
    await writeInPlace(dir, [placement({})], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath,
      quitTimeoutMs: 60_000,
      changedSincePlan: () => [],
      signals,
    });
    // A real process is gone at the second kill; this fake carries on through the cleanup.
    expect(log.slice(0, 2)).toEqual(['quit', 'kill SIGTERM (lock still held)']);
  });

  it('a signal that arrives during the write is re-sent after it, not dropped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app: { isRunning: () => false, quit: () => {}, launch: () => {}, sleep: async () => {} },
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => {
        signals.send('SIGTERM'); // lands while the synchronous write runs
        return [];
      },
      signals,
    });
    expect(result.ok).toBe(true);
    expect(log).toEqual(['kill SIGTERM']);
    expect(signals.listening()).toBe(0);
  });

  it('a signal during the quit itself, with the deck already gone, writes nothing and is re-sent after the relaunch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    let isRunning = true;
    // The quit-wait never polls: Stream Deck is gone by the time quit() returns.
    const app: AppControl = {
      isRunning: () => isRunning,
      quit: () => {
        log.push('quit');
        signals.send('SIGTERM');
        isRunning = false;
      },
      launch: () => void log.push('launch'),
      sleep: async () => void log.push('sleep'),
    };
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => [],
      signals,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('SIGTERM') });
    expect(log).toEqual(['quit', 'launch', 'kill SIGTERM']); // no '(lock still held)': freed before the re-send
    expect(existsSync(lockPath)).toBe(false);
    expect(signals.listening()).toBe(0);
    expect(readCurrentPage(dir)?.actions).toEqual({});
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('a signal while the lock is held and Stream Deck is looked up is deferred, never fatal with the lock on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    let lookups = 0;
    // The first lookup is the synchronous pgrep right after the lock is taken; the deck then quits at once.
    const app: AppControl = {
      isRunning: () => {
        if (lookups++ > 0) return false;
        signals.send('SIGTERM');
        return true;
      },
      quit: () => void log.push('quit'),
      launch: () => void log.push('launch'),
      sleep: async () => void log.push('sleep'),
    };
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app,
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => [],
      signals,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('SIGTERM') });
    expect(log).toEqual(['quit', 'launch', 'kill SIGTERM']);
    expect(existsSync(lockPath)).toBe(false);
    expect(signals.listening()).toBe(0);
    expect(readCurrentPage(dir)?.actions).toEqual({});
  });

  it('a busy lock answers without leaving a signal handler behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    writeFileSync(lockPath, '999');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app: { isRunning: () => true, quit: () => {}, launch: () => {}, sleep: async () => {} },
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => [],
      signals,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('another `jetstream chat`') });
    expect(signals.listening()).toBe(0);
    expect(log).toEqual([]);
  });

  it('a write with no signal re-sends nothing and leaves no handler behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    const log: string[] = [];
    const signals = fakeSignals(log, lockPath);
    const result = await writeInPlace(dir, [placement({ settings: { kind: 'fleet' } })], {
      jetstreamVersion: '3.1.0.0',
      app: { isRunning: () => false, quit: () => {}, launch: () => {}, sleep: async () => {} },
      backupRoot: join(root, 'backups'),
      lockPath,
      changedSincePlan: () => [],
      signals,
    });
    expect(result.ok).toBe(true);
    expect(log).toEqual([]);
    expect(signals.listening()).toBe(0);
  });

  it('the real signal source puts a raw terminal back to normal before it re-sends the signal', () => {
    const log: string[] = [];
    const stdin = { isTTY: true, isRaw: true, setRawMode: (mode: boolean) => void log.push(`setRawMode ${mode}`) };
    processSignals(stdin, (signal) => void log.push(`kill ${signal}`)).kill('SIGINT');
    expect(log).toEqual(['setRawMode false', 'kill SIGINT']);
  });

  it('the real signal source leaves a cooked or non-tty stdin alone and still re-sends the signal', () => {
    const log: string[] = [];
    const setRawMode = (mode: boolean): void => void log.push(`setRawMode ${mode}`);
    const kill = (signal: NodeJS.Signals): void => void log.push(`kill ${signal}`);
    processSignals({ isTTY: true, isRaw: false, setRawMode }, kill).kill('SIGTERM');
    processSignals({ isTTY: false, isRaw: true, setRawMode }, kill).kill('SIGHUP');
    expect(log).toEqual(['kill SIGTERM', 'kill SIGHUP']);
  });

  it('the real signal source still re-sends the signal when the terminal reset fails', () => {
    const log: string[] = [];
    const setRawMode = (): never => {
      throw new Error('EIO: the terminal hung up');
    };
    processSignals({ isTTY: true, isRaw: true, setRawMode }, (signal) => void log.push(`kill ${signal}`)).kill('SIGHUP');
    expect(log).toEqual(['kill SIGHUP']);
  });
});

describe('readForeignCatalog', () => {
  it('lists each distinct third-party key once, with a stable ref, skipping Jetstream and built-in keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const hue = {
      UUID: 'com.elgato.philipshue.power',
      Plugin: { Name: 'Philips Hue', UUID: 'com.elgato.philipshue', Version: '2.2.1.15' },
      Settings: { id: 'l1', name: 'Desk lamp' },
      States: [STATE, {}],
    };
    makeProfile(root, { '0,0': hue, '1,0': slotAction({ kind: 'app' }), '2,0': { UUID: 'com.elgato.streamdeck.system.text' } });
    const second = join(root, 'Other.sdProfile', 'Profiles', 'P1');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'manifest.json'), JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: { '3,3': hue } }] }));
    const catalog = readForeignCatalog(root);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ ref: 'philips-hue-power-1', title: 'Philips Hue power', target: 'Desk lamp' });
  });

  it('does not offer a key with embedded resources, since a copy would lose its files', () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const sound = {
      UUID: 'com.example.soundboard.play',
      Plugin: { Name: 'Soundboard', UUID: 'com.example.soundboard', Version: '1.0' },
      Settings: {},
      Resources: { audioFile: 'Resources/clip.mp3' },
      States: [STATE],
    };
    makeProfile(root, { '0,0': sound, '1,0': { ...sound, UUID: 'com.example.soundboard.stop', Resources: null } });
    expect(readForeignCatalog(root).map((c) => c.uuid)).toEqual(['com.example.soundboard.stop']);
  });
});
