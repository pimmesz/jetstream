import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECK_MODELS,
  DEFAULT_PROFILE_IDS,
  buildDefaultProfile,
  buildProfile,
  buildZip,
  crc32,
  defaultProfileName,
  profileForDeviceType,
  renderProfileArchive,
} from './profile';

const XL = DECK_MODELS.find((d) => d.key === 'xl')!;
const STANDARD = DECK_MODELS.find((d) => d.key === 'standard')!;
const MINI = DECK_MODELS.find((d) => d.key === 'mini')!;

const projects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, path: `/repo/${i}` }));

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('profileForDeviceType', () => {
  it('maps the three bundled device types to their manifest profile names', () => {
    expect(profileForDeviceType(0)).toBe('profiles/Jetstream'); // Standard / MK.2
    expect(profileForDeviceType(1)).toBe('profiles/Jetstream Mini');
    expect(profileForDeviceType(2)).toBe('profiles/Jetstream XL');
  });

  it('has no bundled profile for other devices (Stream Deck +, Pedal, …)', () => {
    expect(profileForDeviceType(7)).toBeUndefined(); // Stream Deck +
    expect(profileForDeviceType(5)).toBeUndefined(); // Pedal
    expect(profileForDeviceType(99)).toBeUndefined();
  });

  it('matches the names declared in the manifest Profiles array', () => {
    const names = [profileForDeviceType(0), profileForDeviceType(1), profileForDeviceType(2)];
    // Same three names buildDefaultProfile stamps as PreconfiguredName.
    const stamped = DECK_MODELS.map((d) => `profiles/${defaultProfileName(d)}`);
    for (const n of names) expect(stamped).toContain(n);
  });
});

describe('buildProfile', () => {
  it('XL: fixed keys at their slots, projects fill the rest with name+path settings', () => {
    const { manifest, placedProjects, skippedProjects } = buildProfile(XL, projects(3));
    const actions = manifest.Actions as Record<string, { UUID: string; Settings: unknown }>;
    expect(actions['0,0']!.UUID).toBe('gg.pim.jetstream.fleet');
    expect(actions['1,0']!.UUID).toBe('gg.pim.jetstream.attention');
    expect(actions['2,0']!.UUID).toBe('gg.pim.jetstream.usage');
    expect(actions['3,0']!.UUID).toBe('gg.pim.jetstream.ci');
    expect(actions['6,0']).toMatchObject({ UUID: 'gg.pim.jetstream.permission', Settings: { decision: 'allow' } });
    expect(actions['7,0']).toMatchObject({ UUID: 'gg.pim.jetstream.permission', Settings: { decision: 'deny' } });
    expect(actions['7,3']!.UUID).toBe('gg.pim.jetstream.settings');
    expect(actions['0,3']!.UUID).toBe('gg.pim.jetstream.launch'); // the XL teaching slot
    // Projects land in the centered middle-rows block first, not row-major from 4,0 —
    // and the 4,0/5,0 moat between the watch strip and Approve/Deny stays empty.
    expect(actions['2,1']).toMatchObject({
      UUID: 'gg.pim.jetstream.project',
      Settings: { name: 'Project 0', path: '/repo/0' },
    });
    expect(actions['3,1']!.UUID).toBe('gg.pim.jetstream.project');
    expect(actions['4,1']!.UUID).toBe('gg.pim.jetstream.project');
    expect(actions['4,0']).toBeUndefined();
    expect(actions['5,0']).toBeUndefined();
    expect(placedProjects).toBe(3);
    expect(skippedProjects).toBe(0);
    expect(manifest.DeviceModel).toBe('20GAT9901');
    expect(manifest.Version).toBe('1.0');
  });

  it('XL overflow spills beyond the centered block but NEVER into the row-0 moat', () => {
    const { manifest, placedProjects } = buildProfile(XL, projects(30));
    const actions = manifest.Actions as Record<string, { UUID: string }>;
    // 32 slots − 8 fixed (fleet/attention/usage/ci/allow/deny/settings/launch) − 2 moat = 22.
    expect(placedProjects).toBe(22);
    expect(actions['4,0']).toBeUndefined();
    expect(actions['5,0']).toBeUndefined();
  });

  it('caps project keys at the free slots and reports the overflow', () => {
    // Standard 5x3 = 15 keys, 7 fixed (fleet/attention/usage/approve/deny/ci/settings) → 8 free.
    const { placedProjects, skippedProjects } = buildProfile(STANDARD, projects(12));
    expect(placedProjects).toBe(8);
    expect(skippedProjects).toBe(4);
  });

  it('Mini: essentials only, never project keys — with each slot decision pinned', () => {
    const { manifest, placedProjects, skippedProjects } = buildProfile(MINI, projects(2));
    const actions = manifest.Actions as Record<string, { UUID: string; Settings: unknown }>;
    expect(Object.keys(actions).sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
    expect(actions['0,0']!.UUID).toBe('gg.pim.jetstream.fleet');
    expect(actions['1,0']!.UUID).toBe('gg.pim.jetstream.attention');
    expect(actions['2,0']!.UUID).toBe('gg.pim.jetstream.usage');
    expect(actions['0,1']).toMatchObject({ UUID: 'gg.pim.jetstream.permission', Settings: { decision: 'allow' } });
    expect(actions['1,1']).toMatchObject({ UUID: 'gg.pim.jetstream.permission', Settings: { decision: 'deny' } });
    expect(actions['2,1']!.UUID).toBe('gg.pim.jetstream.settings');
    expect(placedProjects).toBe(0);
    expect(skippedProjects).toBe(2);
    const uuids = Object.values(actions).map((a) => a.UUID);
    expect(uuids).not.toContain('gg.pim.jetstream.project');
    expect(uuids).not.toContain('gg.pim.jetstream.ci');
  });

  it('every slot stays inside the deck grid', () => {
    for (const deck of DECK_MODELS) {
      const { manifest } = buildProfile(deck, projects(40));
      for (const slot of Object.keys(manifest.Actions as object)) {
        const [col, row] = slot.split(',').map(Number);
        expect(col).toBeLessThan(deck.cols);
        expect(row).toBeLessThan(deck.rows);
      }
    }
  });

  it('every emitted action UUID is declared in the plugin manifest (grounding, not mirroring)', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../gg.pim.jetstream.sdPlugin/manifest.json', import.meta.url), 'utf8'),
    ) as { Actions: Array<{ UUID: string }> };
    const declared = new Set(manifest.Actions.map((a) => a.UUID));
    for (const deck of DECK_MODELS) {
      const { manifest: profile } = buildProfile(deck, projects(40));
      for (const [slot, entry] of Object.entries(profile.Actions as Record<string, { UUID: string }>)) {
        expect(declared, `${deck.key} ${slot} → ${entry.UUID}`).toContain(entry.UUID);
      }
      const { manifest: shipped } = buildDefaultProfile(deck);
      for (const [slot, entry] of Object.entries(shipped.Actions as Record<string, { UUID: string }>)) {
        expect(declared, `default ${deck.key} ${slot} → ${entry.UUID}`).toContain(entry.UUID);
      }
    }
  });
});

describe('buildDefaultProfile (the shipped defaults)', () => {
  it('XL: fixed board + six UNCONFIGURED project invitations, zero user data', () => {
    const { manifest } = buildDefaultProfile(XL);
    const actions = manifest.Actions as Record<string, { UUID: string; Settings: unknown }>;
    expect(Object.keys(actions)).toHaveLength(14); // 8 fixed + 6 invitations
    for (const slot of ['2,1', '3,1', '4,1', '2,2', '3,2', '4,2']) {
      expect(actions[slot]).toMatchObject({ UUID: 'gg.pim.jetstream.project', Settings: null });
    }
    expect(actions['0,3']).toMatchObject({ UUID: 'gg.pim.jetstream.launch', Settings: null });
    expect(actions['4,0']).toBeUndefined(); // the moat ships empty
    expect(actions['5,0']).toBeUndefined();
    expect(manifest.Name).toBe('Jetstream XL');
    // Baked at publish time: no path/name may appear anywhere in the manifest.
    expect(JSON.stringify(manifest)).not.toMatch(/"path"|"name"/);
  });

  it('standard + mini defaults mirror their init layouts with invitations only', () => {
    const std = buildDefaultProfile(STANDARD).manifest;
    const stdActions = std.Actions as Record<string, { UUID: string; Settings: unknown }>;
    expect(Object.keys(stdActions)).toHaveLength(10); // 7 fixed + 3 invitations
    for (const slot of ['1,1', '2,1', '3,1']) {
      expect(stdActions[slot]).toMatchObject({ UUID: 'gg.pim.jetstream.project', Settings: null });
    }
    expect(std.Name).toBe('Jetstream');

    const mini = buildDefaultProfile(MINI).manifest;
    expect(Object.keys(mini.Actions as object)).toHaveLength(6); // essentials fill the Mini
    expect(mini.Name).toBe('Jetstream Mini');
  });

  it('the shipped archives are stable: fixed ids, fixed names, reproducible bytes', () => {
    for (const deck of DECK_MODELS) {
      const a = renderProfileArchive(buildDefaultProfile(deck), DEFAULT_PROFILE_IDS[deck.key]);
      const b = renderProfileArchive(buildDefaultProfile(deck), DEFAULT_PROFILE_IDS[deck.key]);
      expect(a.equals(b)).toBe(true);
      expect(defaultProfileName(deck)).toMatch(/^Jetstream( XL| Mini)?$/);
    }
  });
});

describe('zip writer', () => {
  it('crc32 matches the known value for "hello"', () => {
    // Reference value from the CRC-32 (IEEE 802.3) of the ASCII string "hello".
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
  });

  it('archives are byte-deterministic for the same input', () => {
    const built = buildProfile(XL, projects(2));
    const a = renderProfileArchive(built, 'fixed-id');
    const b = renderProfileArchive(built, 'fixed-id');
    expect(a.equals(b)).toBe(true);
  });

  it('archive bytes are reproducible ACROSS runs (pinned digest — catches run-dependent bytes)', () => {
    const built = buildProfile(XL, projects(2));
    const digest = createHash('sha256').update(renderProfileArchive(built, 'fixed-id')).digest('hex');
    expect(digest).toBe('aff4356285ee20872d7d7ad8ebbefafbe6fc4be823c9860db53f2522a990f288');
  });

  it.skipIf(!hasUnzip && !process.env.CI)('a real unzip extracts the archive and the manifest round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-profile-'));
    tmpDirs.push(dir);
    const built = buildProfile(XL, projects(2));
    const file = join(dir, 'Jetstream.streamDeckProfile');
    writeFileSync(file, renderProfileArchive(built, 'abc-123'));

    execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')]);
    const extracted = JSON.parse(
      readFileSync(join(dir, 'out', 'ABC-123.sdProfile', 'manifest.json'), 'utf8'),
    );
    expect(extracted).toEqual(built.manifest);
  });

  it.skipIf(!hasUnzip && !process.env.CI)('unzip -t verifies archive integrity (CRCs are real, not padding)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-profile-'));
    tmpDirs.push(dir);
    const file = join(dir, 'p.streamDeckProfile');
    writeFileSync(file, buildZip([{ name: 'a/', data: Buffer.alloc(0) }, { name: 'a/x.json', data: Buffer.from('{"k":1}') }]));
    // unzip -t exits non-zero on any CRC/structure error; execFileSync throws then.
    expect(() => execFileSync('unzip', ['-t', file], { stdio: 'ignore' })).not.toThrow();
  });
});
