import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeKeyForModel,
  labelForAction,
  pruneCustomProfiles,
  readBoardLayout,
  renderBoardMap,
  toSlotKey,
} from './board-layout';
import { existsSync } from 'node:fs';

describe('labelForAction', () => {
  it('labels a project by name, else its path basename', () => {
    expect(labelForAction('gg.pim.jetstream.project', { name: 'Falcon', path: '/dev/x' })).toBe('Falcon');
    expect(labelForAction('gg.pim.jetstream.project', { path: '/Users/me/afterburner' })).toBe('afterburner');
  });
  it('labels an open-app key by the app name, stripping the JSON-wrapped quotes + .app', () => {
    expect(labelForAction('com.elgato.streamdeck.system.open', { path: '"/Applications/Telegram.app"' })).toBe(
      'Telegram',
    );
  });
  it('labels a website by hostname, and permission by decision', () => {
    expect(
      labelForAction('com.elgato.streamdeck.system.website', { openInBrowser: true, path: 'https://github.com/x' }),
    ).toBe('github.com');
    expect(labelForAction('gg.pim.jetstream.permission', { decision: 'deny' })).toBe('deny');
    expect(labelForAction('gg.pim.jetstream.permission', {})).toBe('approve');
  });
  it('gives a friendly word for other jetstream keys and a fallback for unknowns', () => {
    expect(labelForAction('gg.pim.jetstream.fleet', null)).toBe('fleet');
    expect(labelForAction('com.elgato.streamdeck.system.hotkey', {})).toBe('hotkey');
  });

  it('labels a slot by its kind (or its label override); empty slots read as ·', () => {
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'app', app: '/Applications/Telegram.app' })).toBe('Telegram');
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'url', url: 'https://www.github.com' })).toBe('github.com');
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'run', command: 'code' })).toBe('code');
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'empty' })).toBe('·');
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'app', app: '/x/Foo.app', label: 'Bar' })).toBe('Bar');
  });
});

describe('toSlotKey (native → slot migration)', () => {
  it('maps system.open → app slot (quotes stripped) and system.website → url slot', () => {
    expect(toSlotKey('com.elgato.streamdeck.system.open', { path: '"/Applications/Telegram.app"' })).toEqual({
      uuid: 'gg.pim.jetstream.slot',
      settings: { kind: 'app', app: '/Applications/Telegram.app', label: 'Telegram' },
    });
    expect(toSlotKey('com.elgato.streamdeck.system.website', { openInBrowser: true, path: 'https://github.com/x' })).toEqual({
      uuid: 'gg.pim.jetstream.slot',
      settings: { kind: 'url', url: 'https://github.com/x' },
    });
  });
  it('leaves Jetstream keys and unmigrated native types (text) alone', () => {
    expect(toSlotKey('gg.pim.jetstream.project', { path: '/x' })).toBeNull();
    expect(toSlotKey('com.elgato.streamdeck.system.text', { pastedText: 'hi' })).toBeNull();
    expect(toSlotKey('com.elgato.streamdeck.system.open', {})).toBeNull(); // no path → nothing to migrate
  });
});

describe('pruneCustomProfiles', () => {
  const project = (name: string) => ({ UUID: 'gg.pim.jetstream.project', Settings: { path: `/x/${name}`, name } });
  const emptySlot = { UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } };

  it('keeps the most-configured Jetstream Custom, deletes the rest, leaves other profiles alone', () => {
    const store = fakeStore([
      { name: 'Default Profile', model: '20GAT9902', actions: { '0,0': project('a'), '1,0': project('b') } },
      { name: 'Jetstream Custom', model: '20GAT9902', actions: { '0,0': emptySlot } }, // 0 configured → pruned
      {
        name: 'Jetstream Custom copy',
        model: '20GAT9902',
        actions: { '0,0': project('a'), '1,0': project('b'), '2,0': project('c') }, // 3 configured → kept
      },
    ]);
    const removed = pruneCustomProfiles(store);
    expect(removed).toHaveLength(1); // only the emptier Custom
    // the richer Custom and the (non-Custom) Default both survive
    expect(existsSync(join(store, 'PROFILE2.sdProfile'))).toBe(true);
    expect(existsSync(join(store, 'PROFILE0.sdProfile'))).toBe(true);
    expect(existsSync(join(store, 'PROFILE1.sdProfile'))).toBe(false);
  });

  it('is a no-op with 0 or 1 Custom profiles', () => {
    expect(pruneCustomProfiles(fakeStore([{ name: 'Jetstream Custom', model: '20GAT9902', actions: {} }]))).toEqual([]);
    expect(pruneCustomProfiles('/nonexistent/xyz')).toEqual([]);
  });

  it('never touches a user profile whose name merely STARTS with "Jetstream Custom"', () => {
    const store = fakeStore([
      { name: 'Jetstream Custom', model: '20GAT9902', actions: { '0,0': emptySlot } }, // 0 configured → pruned
      { name: 'Jetstream Custom Work', model: '20GAT9902', actions: { '0,0': project('a') } }, // user's own → survives
      { name: 'Jetstream Custom copy', model: '20GAT9902', actions: { '0,0': project('a'), '1,0': project('b') } }, // 2 → kept
    ]);
    expect(pruneCustomProfiles(store)).toHaveLength(1);
    expect(existsSync(join(store, 'PROFILE1.sdProfile'))).toBe(true); // "…Work" not matched by the regex
    expect(existsSync(join(store, 'PROFILE2.sdProfile'))).toBe(true); // richest generated Custom kept
    expect(existsSync(join(store, 'PROFILE0.sdProfile'))).toBe(false); // empty generated Custom pruned
  });

  it('keeps ALL profiles tied for the most configured keys (never risks the active board)', () => {
    const acts = { '0,0': project('a'), '1,0': project('b') };
    const store = fakeStore([
      { name: 'Jetstream Custom', model: '20GAT9902', actions: acts },
      { name: 'Jetstream Custom copy', model: '20GAT9902', actions: acts }, // tie at 2 → both kept
    ]);
    expect(pruneCustomProfiles(store)).toEqual([]);
  });
});

describe('describeKeyForModel', () => {
  it('re-emits a slot with its type, target, and cosmetic overrides', () => {
    expect(
      describeKeyForModel({
        uuid: 'gg.pim.jetstream.slot',
        label: 'Telegram',
        settings: { kind: 'app', app: '/Applications/Telegram.app', color: '#e5484d' },
      }),
    ).toBe('open-app app="/Applications/Telegram.app" color="#e5484d"');
    expect(
      describeKeyForModel({ uuid: 'gg.pim.jetstream.slot', label: '·', settings: { kind: 'empty' } }),
    ).toBe('empty');
  });
  it('describes projects and permission keys', () => {
    expect(
      describeKeyForModel({ uuid: 'gg.pim.jetstream.project', label: 'Falcon', settings: { path: '/dev/falcon', name: 'Falcon' } }),
    ).toBe('project path="/dev/falcon" name="Falcon"');
    expect(describeKeyForModel({ uuid: 'gg.pim.jetstream.permission', label: 'deny', settings: { decision: 'deny' } })).toBe('deny');
  });

  it('round-trips run args/cwd and a custom icon so a tweak/move keeps them', () => {
    expect(
      describeKeyForModel({
        uuid: 'gg.pim.jetstream.slot',
        label: 'x',
        settings: { kind: 'run', command: 'code', args: ['/repo'], cwd: '/repo' },
      }),
    ).toBe('run command="code" args=["/repo"] cwd="/repo"');
    expect(
      describeKeyForModel({ uuid: 'gg.pim.jetstream.slot', label: 'x', settings: { kind: 'app', app: '/x.app', icon: '🔥' } }),
    ).toBe('open-app app="/x.app" icon="🔥"');
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a fake ProfilesV3 store with the given profiles (one Keypad page each). */
function fakeStore(
  profiles: Array<{ name: string; model: string; actions: Record<string, { UUID: string; Settings?: unknown }> }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-store-'));
  tmpDirs.push(dir);
  profiles.forEach((p, i) => {
    const prof = join(dir, `PROFILE${i}.sdProfile`);
    const page = join(prof, 'Profiles', `PAGE${i}`);
    mkdirSync(page, { recursive: true });
    writeFileSync(
      join(prof, 'manifest.json'),
      JSON.stringify({ Name: p.name, Device: { Model: p.model, UUID: 'dev' }, Version: '3.0' }),
    );
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: p.actions }] }));
  });
  return dir;
}

describe('readBoardLayout', () => {
  it('reads the Jetstream board (most configured projects), maps coords, matches XL by model prefix', () => {
    const store = fakeStore([
      { name: 'Default Profile', model: '20GAT9902', actions: {} },
      { name: 'Jetstream Grid XL', model: '20GAT9902', actions: { '0,0': { UUID: 'gg.pim.jetstream.coord' } } }, // excluded
      {
        name: 'Jetstream copy',
        model: '20GAT9902',
        actions: {
          '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'headless', path: '/x/headless' } },
          '7,0': { UUID: 'com.elgato.streamdeck.system.open', Settings: { path: '"/Applications/Telegram.app"' } },
          '0,1': { UUID: 'gg.pim.jetstream.fleet', Settings: {} },
        },
      },
    ]);
    const layout = readBoardLayout(store);
    expect(layout?.profileName).toBe('Jetstream copy');
    expect(layout?.deck.key).toBe('xl');
    expect(layout?.keys.get('0,0')?.label).toBe('headless');
    expect(layout?.keys.get('7,0')?.label).toBe('Telegram'); // top-right = a8
    expect(layout?.keys.get('0,1')?.label).toBe('fleet');
  });

  it('returns null when the store is unreadable or has no configured board', () => {
    expect(readBoardLayout('/nonexistent/dir/xyz')).toBeNull();
    expect(readBoardLayout(fakeStore([{ name: 'Default Profile', model: '20GAT9902', actions: {} }]))).toBeNull();
  });

  it('selects a shortcuts-only board (non-empty slots, zero project keys)', () => {
    const layout = readBoardLayout(
      fakeStore([
        { name: 'Default Profile', model: '20GAT9902', actions: {} },
        {
          name: 'Jetstream shortcuts',
          model: '20GAT9902',
          actions: {
            '0,0': { UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'app', app: '/Applications/Telegram.app' } },
            '1,0': { UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } },
          },
        },
      ]),
    );
    expect(layout?.profileName).toBe('Jetstream shortcuts'); // 1 configured slot > 0 → picked
    expect(layout?.keys.get('0,0')?.label).toBe('Telegram');
  });
});

describe('renderBoardMap', () => {
  it('renders a rows×cols grid with each coordinate + label', () => {
    const store = fakeStore([
      {
        name: 'Jetstream',
        model: '20GAT9902',
        actions: { '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'falcon', path: '/x/falcon' } } },
      },
    ]);
    const map = renderBoardMap(readBoardLayout(store)!);
    expect(map).toContain('a1 falcon'); // top-left, labelled
    expect(map).toContain('a8'); // XL has 8 columns → a8 present
    expect(map.split('\n')).toHaveLength(4); // XL has 4 rows
  });
});
