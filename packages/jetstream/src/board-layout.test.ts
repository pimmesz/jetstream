import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  boardContext,
  describeKeyForModel,
  devicesOfModel,
  labelForAction,
  parsePreferredProfiles,
  pruneCustomProfiles,
  readBoardLayout,
  renderBoardMap,
  toSlotKey,
} from './board-layout';
import { existsSync } from 'node:fs';
import { DECK_MODELS } from './profile';

describe('labelForAction', () => {
  // Slot labels are settable through the unauthenticated /slot endpoint and land in the terminal
  // via `jetstream board` / `jetstream chat` — ANSI escapes there could overprint rows and forge
  // the board map the user is reading (and would break the column-width maths).
  it('strips control characters from an attacker-settable label', () => {
    const label = labelForAction('gg.pim.jetstream.slot', { label: 'fleet\x1b[2K\x1b[Afake' });
    expect(label).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(label).toBe('fleet[2K[Afake');
  });

  it('falls back rather than returning a label that was only control characters', () => {
    expect(labelForAction('gg.pim.jetstream.slot', { label: '\x1b\x07', kind: 'project', name: 'Falcon' })).toBe(
      'Falcon',
    );
  });

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

  it('labels a folded project slot by name/basename (so the board map is not blank)', () => {
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'project', name: 'Falcon', path: '/dev/x' })).toBe('Falcon');
    expect(labelForAction('gg.pim.jetstream.slot', { kind: 'project', path: '/Users/me/loudini' })).toBe('loudini');
  });

  // A run of quotes followed by another character made /^"+|"+$/ backtrack quadratically: seconds per call.
  it('strips the quotes around an app path in linear time, even with 200k quotes inside it', () => {
    const path = `x${'"'.repeat(200_000)}y`;
    const timed = (run: () => unknown): number => {
      const start = performance.now();
      run();
      return performance.now() - start;
    };
    expect(timed(() => labelForAction('com.elgato.streamdeck.system.open', { path }))).toBeLessThan(1000);
    expect(timed(() => labelForAction('gg.pim.jetstream.slot', { kind: 'app', app: path }))).toBeLessThan(1000);
    expect(timed(() => toSlotKey('com.elgato.streamdeck.system.open', { path }))).toBeLessThan(1000);
    expect(toSlotKey('com.elgato.streamdeck.system.open', { path: `"${path}"` })?.settings.app).toBe(path);
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
  it('migrates the older standalone Jetstream keys to slot kinds, so later edits apply live', () => {
    expect(toSlotKey('gg.pim.jetstream.project', { path: '/x', name: 'X' })).toEqual({
      uuid: 'gg.pim.jetstream.slot',
      settings: { kind: 'project', path: '/x', name: 'X' },
    });
    expect(toSlotKey('gg.pim.jetstream.fleet', null)?.settings).toEqual({ kind: 'fleet' });
    expect(toSlotKey('gg.pim.jetstream.usage', null)?.settings).toEqual({ kind: 'usage' });
    expect(toSlotKey('gg.pim.jetstream.attention', null)?.settings).toEqual({ kind: 'attention' });
    // The slot stopall kind is inert until allowStopKeys, so a working stop-all key stays native.
    expect(toSlotKey('gg.pim.jetstream.interruptall', null)).toBeNull();
    // A project key with no path is the bundled default board's placeholder: leave it native.
    expect(toSlotKey('gg.pim.jetstream.project', {})).toBeNull();
  });

  it('leaves slots and unmigrated native types (text) alone', () => {
    expect(toSlotKey('gg.pim.jetstream.slot', { kind: 'app', app: '/A.app' })).toBeNull();
    expect(toSlotKey('com.elgato.streamdeck.system.text', { pastedText: 'hi' })).toBeNull();
    expect(toSlotKey('com.elgato.streamdeck.system.open', {})).toBeNull(); // no path → nothing to migrate
  });
});

describe('parsePreferredProfiles', () => {
  // Shaped like `defaults read com.elgato.StreamDeck` on Stream Deck 7 with three devices; ids redacted.
  const output = [
    '{',
    '    Devices =     {',
    '        "device-1" =         {',
    '            DeviceName = "Stream Deck";',
    '            ESDProfilesInfo =             {',
    '                ESDProfilesPreferred = "AAAAAAAA-1111-2222-3333-444444444444";',
    '            };',
    '        };',
    '        "device-2" =         {',
    '            DeviceName = "Stream Deck XL";',
    '            ESDProfilesInfo =             {',
    '                ESDProfilesPreferred = "BBBBBBBB-1111-2222-3333-444444444444";',
    '                ESDProfilesSorting = "CCCCCCCC-1111-2222-3333-444444444444,DDDDDDDD-1111-2222-3333-444444444444";',
    '            };',
    '        };',
    '        "device-3" =         {',
    '            DeviceName = "Stream Deck Mobile";',
    '            ESDProfilesInfo =             {',
    '                ESDProfilesPreferred = "EEEEEEEE-1111-2222-3333-444444444444";',
    '            };',
    '        };',
    '    };',
    '}',
  ].join('\n');

  it('returns each device\'s preferred profile, lowercased, and never a profile from the sort order', () => {
    expect(parsePreferredProfiles(output)).toEqual([
      'aaaaaaaa-1111-2222-3333-444444444444',
      'bbbbbbbb-1111-2222-3333-444444444444',
      'eeeeeeee-1111-2222-3333-444444444444',
    ]);
  });

  it('returns nothing for output without a preferred profile', () => {
    expect(parsePreferredProfiles('{\n    ESDDebug = 0;\n}')).toEqual([]);
  });
});

describe('pruneCustomProfiles', () => {
  const project = (name: string) => ({ UUID: 'gg.pim.jetstream.project', Settings: { path: `/x/${name}`, name } });
  const emptySlot = { UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } };
  // fakeStore names dirs PROFILE0.sdProfile, PROFILE1.sdProfile, … → the injectable "active uuid" is
  // the dir basename lowercased (profile0, profile1, …).
  const older = (store: string, dir: string) => utimesSync(join(store, dir), 1_000, 1_000);

  it('keeps the ACTIVE Jetstream Custom even when it is simpler, deletes the rest, leaves other profiles alone', () => {
    const store = fakeStore([
      { name: 'Default Profile', model: '20GAT9902', actions: { '0,0': project('a'), '1,0': project('b') } },
      { name: 'Jetstream Custom', model: '20GAT9902', actions: { '0,0': emptySlot } }, // ACTIVE → kept, though emptier
      {
        name: 'Jetstream Custom copy',
        model: '20GAT9902',
        actions: { '0,0': project('a'), '1,0': project('b'), '2,0': project('c') },
      },
    ]);
    const removed = pruneCustomProfiles(store, ['profile1']); // Stream Deck is ON the simpler board
    expect(removed).toHaveLength(1); // only the non-active copy
    expect(existsSync(join(store, 'PROFILE1.sdProfile'))).toBe(true); // the active board is never deleted
    expect(existsSync(join(store, 'PROFILE0.sdProfile'))).toBe(true); // the (non-Custom) Default survives
    expect(existsSync(join(store, 'PROFILE2.sdProfile'))).toBe(false); // the redundant copy is pruned
  });

  it('keeps EVERY active Custom (multi-device), pruning only the non-active copy', () => {
    const acts = { '0,0': project('a') };
    const store = fakeStore([
      { name: 'Jetstream Custom', model: '20GAT9902', actions: acts }, // PROFILE0 — active on deck 1
      { name: 'Jetstream Custom copy', model: '20GAT9902', actions: acts }, // PROFILE1 — active on deck 2
      { name: 'Jetstream Custom copy 2', model: '20GAT9902', actions: acts }, // PROFILE2 — stale, not active
    ]);
    // Two decks report two different preferred profiles — deleting either active board is data loss.
    const removed = pruneCustomProfiles(store, ['profile0', 'profile1']);
    expect(removed).toEqual(['PROFILE2.sdProfile']);
    expect(existsSync(join(store, 'PROFILE0.sdProfile'))).toBe(true); // deck 1's active board kept
    expect(existsSync(join(store, 'PROFILE1.sdProfile'))).toBe(true); // deck 2's active board kept
  });

  it('never prunes across device MODELS — a different deck’s board is safe even when inactive', () => {
    const store = fakeStore([
      { name: 'Jetstream Custom', model: '20GAT9902', actions: { '0,0': project('a') } }, // PROFILE0 XL — active
      { name: 'Jetstream Custom copy', model: '20GAT9902', actions: { '0,0': project('a') } }, // PROFILE1 XL — inactive
      { name: 'Jetstream Custom', model: '20GBA9902', actions: { '0,0': project('b') } }, // PROFILE2 Standard — inactive, other model
    ]);
    const removed = pruneCustomProfiles(store, ['profile0']); // only the XL board is active
    expect(removed).toEqual(['PROFILE1.sdProfile']); // only the redundant SAME-model copy
    expect(existsSync(join(store, 'PROFILE2.sdProfile'))).toBe(true); // the Standard deck's board survives
  });

  it('falls back to the most-recently-modified Custom when the active one is unknown', () => {
    const acts = { '0,0': project('a') };
    const store = fakeStore([
      { name: 'Jetstream Custom', model: '20GAT9902', actions: acts },
      { name: 'Jetstream Custom copy', model: '20GAT9902', actions: acts }, // newest by mtime → kept
    ]);
    older(store, 'PROFILE0.sdProfile'); // PROFILE1 is now the newer board
    const removed = pruneCustomProfiles(store, []); // no active uuid → mtime decides
    expect(removed).toEqual(['PROFILE0.sdProfile']);
    expect(existsSync(join(store, 'PROFILE1.sdProfile'))).toBe(true);
  });

  it('is a no-op with 0 or 1 Custom profiles', () => {
    expect(pruneCustomProfiles(fakeStore([{ name: 'Jetstream Custom', model: '20GAT9902', actions: {} }]), [])).toEqual(
      [],
    );
    expect(pruneCustomProfiles('/nonexistent/xyz', [])).toEqual([]);
  });

  it('never touches a user profile whose name merely STARTS with "Jetstream Custom"', () => {
    const store = fakeStore([
      { name: 'Jetstream Custom', model: '20GAT9902', actions: { '0,0': emptySlot } }, // non-active → pruned
      { name: 'Jetstream Custom Work', model: '20GAT9902', actions: { '0,0': project('a') } }, // user's own → survives
      { name: 'Jetstream Custom copy', model: '20GAT9902', actions: { '0,0': project('a'), '1,0': project('b') } },
    ]);
    older(store, 'PROFILE0.sdProfile'); // make the copy the newest so mtime keeps it
    expect(pruneCustomProfiles(store, [])).toHaveLength(1);
    expect(existsSync(join(store, 'PROFILE1.sdProfile'))).toBe(true); // "…Work" not matched by the regex
    expect(existsSync(join(store, 'PROFILE2.sdProfile'))).toBe(true); // newest generated Custom kept
    expect(existsSync(join(store, 'PROFILE0.sdProfile'))).toBe(false); // older generated Custom pruned
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

  it('round-trips a folded project slot (path/name) so a MOVE keeps the repo, not reads it as empty', () => {
    expect(
      describeKeyForModel({
        uuid: 'gg.pim.jetstream.slot',
        label: 'Loudini',
        settings: { kind: 'project', path: '/dev/loudini', name: 'Loudini' },
      }),
    ).toBe('project path="/dev/loudini" name="Loudini"');
    // the other folded kinds round-trip as their chat type name too (visible + movable, not 'empty')
    expect(describeKeyForModel({ uuid: 'gg.pim.jetstream.slot', label: 'fleet', settings: { kind: 'fleet' } })).toBe('fleet');
    expect(describeKeyForModel({ uuid: 'gg.pim.jetstream.slot', label: 'stop', settings: { kind: 'stopall' } })).toBe('stop-all');
    expect(describeKeyForModel({ uuid: 'gg.pim.jetstream.slot', label: 'vol+', settings: { kind: 'volup' } })).toBe('volup');
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

type StoredKeys = Record<string, { UUID: string; Settings?: unknown }>;

/** Build a fake ProfilesV3 store in the Stream Deck 7 shape: profile i shows page `page<i>` (`actions`),
 * and `otherPage` adds a second page `page<i>-2` it does not show. `isLegacy` omits the `Pages` listing. */
function fakeStore(
  profiles: Array<{ name: string; model: string; actions: StoredKeys; otherPage?: StoredKeys; isLegacy?: boolean; device?: string }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-store-'));
  tmpDirs.push(dir);
  profiles.forEach((p, i) => {
    const prof = join(dir, `PROFILE${i}.sdProfile`);
    const pages: Array<[string, StoredKeys]> = [[`page${i}`, p.actions]];
    if (p.otherPage) pages.push([`page${i}-2`, p.otherPage]);
    for (const [id, actions] of pages) {
      // Stream Deck stores page directories upper-case while the manifest lists their ids lower-case.
      const page = join(prof, 'Profiles', id.toUpperCase());
      mkdirSync(page, { recursive: true });
      writeFileSync(join(page, 'manifest.json'), JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: actions }] }));
    }
    const listing = p.isLegacy ? {} : { Pages: { Current: `page${i}`, Pages: pages.map(([id]) => id) } };
    writeFileSync(
      join(prof, 'manifest.json'),
      JSON.stringify({ Name: p.name, Device: { Model: p.model, UUID: p.device ?? 'dev' }, Version: '3.0', ...listing }),
    );
  });
  return dir;
}

describe('devicesOfModel', () => {
  const xl = DECK_MODELS.find((d) => d.key === 'xl')!;

  it('counts one XL however many profiles it has, and ignores other models', () => {
    const store = fakeStore([
      { name: 'Default Profile', model: '20GAT9902', actions: {}, device: 'xl-1' },
      { name: 'Jetstream', model: '20GAT9902', actions: {}, device: 'xl-1' },
      { name: 'Mini', model: '20GAI9901', actions: {}, device: 'mini-1' },
    ]);
    expect(devicesOfModel(xl, store)).toBe(1);
  });

  it('counts two XLs, so a key code alone cannot say which one was pressed', () => {
    const store = fakeStore([
      { name: 'Jetstream', model: '20GAT9902', actions: {}, device: 'xl-1' },
      { name: 'Other', model: '20GAT9902', actions: {}, device: 'xl-2' },
    ]);
    expect(devicesOfModel(xl, store)).toBe(2);
  });

  it('is 0 when the store cannot be read', () => {
    expect(devicesOfModel(xl, join(tmpdir(), 'jetstream-no-store-here'))).toBe(0);
  });
});

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
    const layout = readBoardLayout(store, []); // no active profile → most-configured fallback
    expect(layout?.profileName).toBe('Jetstream copy');
    expect(layout?.deck.key).toBe('xl');
    expect(layout?.keys.get('0,0')?.label).toBe('headless');
    expect(layout?.keys.get('7,0')?.label).toBe('Telegram'); // top-right = a8
    expect(layout?.keys.get('0,1')?.label).toBe('fleet');
  });

  it('returns null when the store is unreadable or has no configured board', () => {
    expect(readBoardLayout('/nonexistent/dir/xyz', [])).toBeNull();
    expect(readBoardLayout(fakeStore([{ name: 'Default Profile', model: '20GAT9902', actions: {} }]), [])).toBeNull();
  });

  it('prefers the ACTIVE profile over a richer inactive one', () => {
    const store = fakeStore([
      // PROFILE0 — the board Stream Deck is ON, but only 1 configured key
      {
        name: 'Jetstream Custom',
        model: '20GAT9902',
        actions: { '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'onkey', path: '/x/onkey' } } },
      },
      // PROFILE1 — richer (3 keys) but NOT active; the old max-configured heuristic would wrongly pick this
      {
        name: 'Jetstream Custom copy',
        model: '20GAT9902',
        actions: {
          '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'a', path: '/x/a' } },
          '1,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'b', path: '/x/b' } },
          '2,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'c', path: '/x/c' } },
        },
      },
    ]);
    const layout = readBoardLayout(store, ['profile0']); // Stream Deck is ON the simpler board
    expect(layout?.profileName).toBe('Jetstream Custom'); // active wins despite fewer keys
    expect(layout?.keys.get('0,0')?.label).toBe('onkey');
  });

  it('does NOT let an active NON-Jetstream profile masquerade as your board', () => {
    const store = fakeStore([
      // PROFILE0 — the profile Stream Deck is currently ON, but it's a plain hotkey page, no Jetstream keys
      { name: 'Spotify', model: '20GAT9902', actions: { '0,0': { UUID: 'com.spotify.hotkey', Settings: {} } } },
      // PROFILE1 — an INACTIVE real Jetstream board
      {
        name: 'Jetstream Custom',
        model: '20GAT9902',
        actions: { '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'falcon', path: '/x/falcon' } } },
      },
    ]);
    const layout = readBoardLayout(store, ['profile0']); // active = the Spotify page
    expect(layout?.profileName).toBe('Jetstream Custom'); // the Jetstream board wins, not the active non-Jetstream one
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
      [],
    );
    expect(layout?.profileName).toBe('Jetstream shortcuts'); // 1 configured slot > 0 → picked
    expect(layout?.keys.get('0,0')?.label).toBe('Telegram');
  });

  it('reads only the page the deck shows, and names it, never keys from another page', () => {
    const store = fakeStore([
      {
        name: 'Jetstream',
        model: '20GAT9902',
        actions: { '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'falcon', path: '/x/falcon' } } },
        // The second page holds keys at coordinates the shown page leaves empty.
        otherPage: {
          '1,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'hidden', path: '/x/hidden' } },
          '2,0': { UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'app', app: '/Applications/Telegram.app' } },
        },
      },
    ]);
    const layout = readBoardLayout(store, []);
    expect(layout?.pageId).toBe('page0');
    expect([...(layout?.keys.keys() ?? [])]).toEqual(['0,0']);
    const map = renderBoardMap(layout!);
    expect(map).toContain('a1 falcon');
    expect(map).not.toContain('hidden');
    expect(map).not.toContain('Telegram');
  });

  it('merges every page for a profile with no Pages listing (before Stream Deck 7)', () => {
    const store = fakeStore([
      {
        name: 'Jetstream',
        model: '20GAT9902',
        isLegacy: true,
        actions: { '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'falcon', path: '/x/falcon' } } },
        otherPage: { '1,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'second', path: '/x/second' } } },
      },
    ]);
    const layout = readBoardLayout(store, []);
    expect(layout?.pageId).toBeUndefined();
    expect(layout?.keys.get('0,0')?.label).toBe('falcon');
    expect(layout?.keys.get('1,0')?.label).toBe('second');
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
    const map = renderBoardMap(readBoardLayout(store, [])!);
    expect(map).toContain('a1 falcon'); // top-left, labelled
    expect(map).toContain('a8'); // XL has 8 columns → a8 present
    expect(map.split('\n')).toHaveLength(4); // XL has 4 rows
  });

  // Only chat's Apply preview shows a longer Text key; the board map and the model prompt stay short.
  it('shows 8 characters of a long Text key, in the board map and in the model prompt', () => {
    const store = fakeStore([
      {
        name: 'Jetstream',
        model: '20GAT9902',
        actions: {
          '0,0': { UUID: 'com.elgato.streamdeck.system.text', Settings: { pastedText: 'git push --force origin main' } },
          '1,0': { UUID: 'gg.pim.jetstream.project', Settings: { name: 'falcon', path: '/x/falcon' } },
        },
      },
    ]);
    const layout = readBoardLayout(store, [])!;
    const map = renderBoardMap(layout);
    expect(map).toContain('a1 git push ');
    expect(map).not.toContain('git push -');
    const context = boardContext(layout);
    expect(context).toContain('  a1: git push (cannot be moved by chat)');
    expect(context).not.toContain('git push -');
  });
});
