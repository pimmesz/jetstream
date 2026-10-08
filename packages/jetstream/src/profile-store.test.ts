import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { overlayActions, readCurrentPage, writeInPlace, type AppControl, type StoredAction } from './profile-store';
import { readForeignCatalog } from './plugin-catalog';
import type { Placement } from './layout';

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
    });
    expect(result.ok).toBe(false);
    expect(launched).toEqual(['launch']);
    expect(readCurrentPage(dir)?.actions).toEqual({});
  });
});

describe('writeInPlace lock', () => {
  const app = (): AppControl => ({ isRunning: () => false, quit: () => {}, launch: () => {}, sleep: async () => {} });

  it('refuses while another writer holds the lock, and releases its own lock when done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'js-store-'));
    const dir = makeProfile(root, {});
    const lockPath = join(root, 'write.lock');
    writeFileSync(lockPath, '999');
    const opts = { jetstreamVersion: '3.1.0.0', app: app(), backupRoot: join(root, 'backups'), lockPath };
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
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('another writer');
    writeFileSync(join(root, 'not-a-dir'), '');
    const blocked = await writeInPlace(dir, [placement({})], {
      jetstreamVersion: '3.1.0.0',
      app: app(),
      backupRoot: join(root, 'backups'),
      lockPath: join(root, 'not-a-dir', 'write.lock'),
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
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain(lockPath);
    expect(readCurrentPage(dir)?.actions).toEqual({}); // nothing written
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
