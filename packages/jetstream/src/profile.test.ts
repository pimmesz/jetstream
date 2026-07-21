import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECK_MODELS,
  DEFAULT_PROFILE_IDS,
  buildDefaultProfile,
  buildProfile,
  buildZip,
  buildOpsProfile,
  crc32,
  deckForDeviceType,
  detectConnectedDeck,
  detectDeviceModel,
  defaultProfileName,
  opsProfileName,
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

describe('detectConnectedDeck', () => {
  const makeStore = (models: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-profiles-'));
    tmpDirs.push(dir);
    models.forEach((model, i) => {
      const p = join(dir, `P${i}.sdProfile`);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'manifest.json'), JSON.stringify({ Model: model, Name: 'x' }));
    });
    return dir;
  };

  it('returns the deck when exactly one family is present in the store', () => {
    expect(detectConnectedDeck(makeStore([XL.model, XL.model]))?.key).toBe('xl');
  });
  it('returns undefined when two families are present (ambiguous → let the user pick)', () => {
    expect(detectConnectedDeck(makeStore([XL.model, MINI.model]))).toBeUndefined();
  });
  it('returns undefined for an empty store or a missing directory', () => {
    expect(detectConnectedDeck(makeStore([]))).toBeUndefined();
    expect(detectConnectedDeck(join(tmpdir(), 'jetstream-no-such-store-xyz'))).toBeUndefined();
  });
  it('matches by 7-char prefix, so a device revision still resolves', () => {
    // An XL revision like 20GAT9902 shares the 20GAT99 prefix with the pinned 20GAT9901.
    expect(detectConnectedDeck(makeStore(['20GAT9902']))?.key).toBe('xl');
  });
});

describe('detectDeviceModel', () => {
  const makeStore = (models: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-devmodel-'));
    tmpDirs.push(dir);
    models.forEach((model, i) => {
      const p = join(dir, `P${i}.sdProfile`);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'manifest.json'), JSON.stringify({ Model: model, Name: 'x' }));
    });
    return dir;
  };

  it('returns the connected hardware REVISION for the deck family, not the pinned default', () => {
    // The whole point: an init profile stamped 20GAT9901 can refuse to import on a 9902 XL.
    expect(detectDeviceModel(XL, makeStore(['20GAT9902']))).toBe('20GAT9902');
  });
  it('ignores other families and falls back to the family default when nothing matches', () => {
    expect(detectDeviceModel(XL, makeStore([MINI.model]))).toBe(XL.model);
    expect(detectDeviceModel(XL, join(tmpdir(), 'jetstream-no-store-xyz'))).toBe(XL.model);
  });
  it('prefers the most recently MODIFIED family match (stale replaced-device profiles lose)', () => {
    const dir = makeStore(['20GAT9901', '20GAT9902']);
    // P0 (9901) is the stale dead device; make P1 (9902) the recently-used one.
    const old = new Date(Date.now() - 7 * 24 * 3600_000);
    utimesSync(join(dir, 'P0.sdProfile'), old, old);
    expect(detectDeviceModel(XL, dir)).toBe('20GAT9902');
  });
  it('one unreadable profile never aborts the scan', () => {
    const dir = makeStore(['20GAT9902']);
    mkdirSync(join(dir, 'A0.sdProfile'), { recursive: true }); // no manifest.json at all
    expect(detectDeviceModel(XL, dir)).toBe('20GAT9902');
  });
});

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

  it('deckForDeviceType maps to the DeckModel used by "Build my layout" (else undefined)', () => {
    expect(deckForDeviceType(0)).toBe(STANDARD);
    expect(deckForDeviceType(1)).toBe(MINI);
    expect(deckForDeviceType(2)).toBe(XL);
    expect(deckForDeviceType(7)).toBeUndefined(); // Stream Deck +
    expect(deckForDeviceType(99)).toBeUndefined();
  });

  it('matches the names declared in the manifest Profiles array', () => {
    const names = [profileForDeviceType(0), profileForDeviceType(1), profileForDeviceType(2)];
    // Same three names buildDefaultProfile stamps as PreconfiguredName.
    const stamped = DECK_MODELS.map((d) => `profiles/${defaultProfileName(d)}`);
    for (const n of names) expect(stamped).toContain(n);
  });
});

describe('buildProfile', () => {
  it('XL: usage + settings anchor the bottom-left, projects fill the top-left with name+path settings', () => {
    const { manifest, placedProjects, skippedProjects } = buildProfile(XL, projects(3));
    const actions = manifest.Actions as Record<string, { UUID: string; Settings: unknown }>;
    // The XL default board is projects + two touches: the Usage gauge (d1) and the Jetstream mark
    // (a8). CI, Launch, Approve/Deny and Settings are intentionally OFF the default XL board; the
    // volume strip, Ops nav and Grid toggle are gone too.
    expect(actions['0,3']!.UUID).toBe('gg.pim.jetstream.usage');
    expect(actions['7,0']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'logo' } });
    const slotKinds = Object.values(actions)
      .filter((a) => a.UUID === 'gg.pim.jetstream.slot')
      .map((a) => (a.Settings as { kind?: string } | null)?.kind);
    expect(slotKinds).not.toContain('volup');
    expect(slotKinds).not.toContain('voldown');
    expect(slotKinds).not.toContain('volmute');
    const xlUuids = Object.values(actions).map((a) => a.UUID);
    expect(xlUuids).not.toContain('gg.pim.jetstream.fleet');
    expect(xlUuids).not.toContain('gg.pim.jetstream.attention');
    expect(xlUuids).not.toContain('gg.pim.jetstream.nav'); // Ops page no longer linked from the board
    expect(xlUuids).not.toContain('gg.pim.jetstream.grid'); // Grid toggle removed
    expect(xlUuids).not.toContain('gg.pim.jetstream.ci'); // control keys dropped from the XL default
    expect(xlUuids).not.toContain('gg.pim.jetstream.launch');
    expect(xlUuids).not.toContain('gg.pim.jetstream.permission');
    // Settings IS on the XL default now, at d2 beside the usage gauge: a press opens
    // `jetstream doctor`, and its inspector is where theme/timings/fleet live.
    expect(xlUuids).toContain('gg.pim.jetstream.settings');
    // Projects fill the top row left-to-right, starting top-left.
    expect(actions['0,0']).toMatchObject({
      UUID: 'gg.pim.jetstream.project',
      Settings: { name: 'Project 0', path: '/repo/0' },
    });
    expect(actions['1,0']!.UUID).toBe('gg.pim.jetstream.project');
    expect(actions['2,0']!.UUID).toBe('gg.pim.jetstream.project');
    expect(placedProjects).toBe(3);
    expect(skippedProjects).toBe(0);
    expect(manifest.DeviceModel).toBe('20GAT9901');
    expect(manifest.Version).toBe('1.0');
  });

  it('XL overflow: projects fill the free slots, capped by the three fixed keys', () => {
    const { manifest, placedProjects } = buildProfile(XL, projects(40));
    const actions = manifest.Actions as Record<string, { UUID: string }>;
    // 32 slots − 1 Usage gauge (d1) − 1 logo (a8) = 30 project slots. Every other control was dropped.
    expect(placedProjects).toBe(29); // 32 keys − usage(d1) − settings(d2) − logo(a8)
    expect(actions['0,0']!.UUID).toBe('gg.pim.jetstream.project'); // top-left is a project
    expect(actions['1,3']!.UUID).toBe('gg.pim.jetstream.settings'); // d2 — press opens `jetstream doctor`
    expect(actions['0,3']!.UUID).toBe('gg.pim.jetstream.usage'); // Usage still anchors d1
  });

  it('caps project keys at the free slots and reports the overflow', () => {
    // Standard 5x3 = 15 keys, 7 controls (watch strip + settings + nav/approve/deny) → 8 free.
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
    // The whole board is plugin-owned now: 2 controls (Usage on d1 + the mark on a8) + 6 invitations
    // + the rest filled with empty slots. CI/Launch/Approve/Deny/Settings are off the XL default.
    expect(Object.keys(actions)).toHaveLength(XL.cols * XL.rows);
    for (const slot of ['0,0', '1,0', '2,0', '3,0', '4,0', '5,0']) {
      expect(actions[slot]).toMatchObject({ UUID: 'gg.pim.jetstream.project', Settings: null });
    }
    expect(actions['0,3']!.UUID).toBe('gg.pim.jetstream.usage'); // Usage gauge anchors d1
    expect(actions['7,0']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'logo' } }); // a8 mark
    // The dropped control slots (c8 Settings, d3 Launch) are now plain empty slots.
    expect(actions['7,2']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } });
    expect(actions['2,3']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } });
    expect(actions['6,0']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } }); // unplaced → slot
    const defUuids = Object.values(actions).map((a) => a.UUID);
    expect(defUuids).toContain('gg.pim.jetstream.settings'); // d2
    expect(defUuids).not.toContain('gg.pim.jetstream.ci');
    expect(manifest.Name).toBe('Jetstream XL');
    // Baked at publish time: no path/name may appear anywhere in the manifest.
    expect(JSON.stringify(manifest)).not.toMatch(/"path"|"name"/);
  });

  it('standard + mini defaults mirror their init layouts with invitations only', () => {
    const std = buildDefaultProfile(STANDARD).manifest;
    const stdActions = std.Actions as Record<string, { UUID: string; Settings: unknown }>;
    // Full board: 8 controls + 3 invitations + empty slots filling the rest.
    expect(Object.keys(stdActions)).toHaveLength(STANDARD.cols * STANDARD.rows);
    for (const slot of ['0,0', '1,0', '2,0']) {
      expect(stdActions[slot]).toMatchObject({ UUID: 'gg.pim.jetstream.project', Settings: null });
    }
    expect(std.Name).toBe('Jetstream');

    const mini = buildDefaultProfile(MINI).manifest;
    // The Mini has no room for a second page, so no nav key — essentials only (its 6 keys are all
    // fixed, so nothing to fill).
    expect(Object.keys(mini.Actions as object)).toHaveLength(6);
    expect(mini.Name).toBe('Jetstream Mini');
    expect(Object.values(mini.Actions as Record<string, { UUID: string }>).map((a) => a.UUID)).not.toContain(
      'gg.pim.jetstream.nav',
    );
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

describe('buildOpsProfile (the shipped controls page)', () => {
  it('places the control keys + a nav back to the board, zero user data (standard + XL)', () => {
    for (const deck of [STANDARD, XL]) {
      const { manifest } = buildOpsProfile(deck);
      const actions = manifest.Actions as Record<string, { UUID: string; Settings: unknown }>;
      const uuids = Object.values(actions).map((a) => a.UUID);
      expect(actions['0,0']).toMatchObject({ UUID: 'gg.pim.jetstream.nav', Settings: { target: 'board' } });
      for (const u of ['gg.pim.jetstream.interruptall', 'gg.pim.jetstream.settings']) {
        expect(uuids).toContain(u);
      }
      // The afterburner-driving keys are gone from the ops page, and so are the deleted
      // CI / Launch / Model keys — a profile naming one would place a key with no code behind it.
      for (const u of [
        'gg.pim.jetstream.heartbeat',
        'gg.pim.jetstream.review',
        'gg.pim.jetstream.ci',
        'gg.pim.jetstream.launch',
        'gg.pim.jetstream.model',
      ]) {
        expect(uuids).not.toContain(u);
      }
      expect(JSON.stringify(manifest)).not.toMatch(/"path"|"name"/); // baked — no user data
    }
    expect(opsProfileName(STANDARD)).toBe('Jetstream Ops');
    expect(opsProfileName(XL)).toBe('Jetstream Ops XL');
  });

  it('every Ops action + profile is declared in the manifest (so switchToProfile accepts them)', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../gg.pim.jetstream.sdPlugin/manifest.json', import.meta.url), 'utf8'),
    ) as { Actions: Array<{ UUID: string }>; Profiles: Array<{ Name: string }> };
    const declared = new Set(manifest.Actions.map((a) => a.UUID));
    for (const deck of [STANDARD, XL]) {
      for (const [slot, entry] of Object.entries(
        buildOpsProfile(deck).manifest.Actions as Record<string, { UUID: string }>,
      )) {
        expect(declared, `ops ${deck.key} ${slot} → ${entry.UUID}`).toContain(entry.UUID);
      }
    }
    const profileNames = new Set(manifest.Profiles.map((p) => p.Name));
    expect(profileNames).toContain('profiles/Jetstream Ops');
    expect(profileNames).toContain('profiles/Jetstream Ops XL');
  });

  it('the manifest declares exactly the actions that have an implementation', () => {
    // Deleting an action's source file but leaving its manifest entry ships a key the user can
    // place and that then does nothing — Stream Deck lists it, no code ever answers. The reverse
    // (implemented but undeclared) is just as dead. Compare both sets so neither can drift.
    const manifest = JSON.parse(
      readFileSync(new URL('../gg.pim.jetstream.sdPlugin/manifest.json', import.meta.url), 'utf8'),
    ) as { Actions: Array<{ UUID: string }> };
    const actionsDir = new URL('./actions/', import.meta.url);
    // Strip line + block comments before scraping so a UUID mentioned in a comment (or a
    // commented-out @action) does NOT count as implemented — that false-green ships a key the SDK
    // never answers. Quote-agnostic ('…' or "…") so a prettier reflow can't false-red the build.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const implemented = readdirSync(actionsDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) => [
        ...stripComments(readFileSync(new URL(f, actionsDir), 'utf8')).matchAll(
          /@action\(\{\s*UUID:\s*['"]([^'"]+)['"]/g,
        ),
      ])
      .map((m) => m[1]!);
    expect(new Set(manifest.Actions.map((a) => a.UUID))).toEqual(new Set(implemented));
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
    expect(digest).toBe('0ac2c2d5e28bde31bf2ee44b61b343f65f69bb23e5529947c6cc5fcb48a514da');
  });

  it.skipIf(!hasUnzip)('a real unzip extracts the archive and the manifest round-trips', () => {
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

  it.skipIf(!hasUnzip)('unzip -t verifies archive integrity (CRCs are real, not padding)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-profile-'));
    tmpDirs.push(dir);
    const file = join(dir, 'p.streamDeckProfile');
    writeFileSync(file, buildZip([{ name: 'a/', data: Buffer.alloc(0) }, { name: 'a/x.json', data: Buffer.from('{"k":1}') }]));
    // unzip -t exits non-zero on any CRC/structure error; execFileSync throws then.
    expect(() => execFileSync('unzip', ['-t', file], { stdio: 'ignore' })).not.toThrow();
  });

  // Structural validity WITHOUT the `unzip` binary — this runs everywhere, so a byte-deterministic
  // but CORRUPT archive (which the pinned-digest test would happily re-pin) is caught. The writer is
  // STORE-only, so each entry's stored bytes are its raw bytes: recompute the CRC and compare, and
  // verify the End-Of-Central-Directory record. A byte-flip in the data must break it.
  const walkStoredEntries = (zip: Buffer): Array<{ name: string; crc: number; data: Buffer }> => {
    const entries: Array<{ name: string; crc: number; data: Buffer }> = [];
    let p = 0;
    while (p + 4 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
      const crc = zip.readUInt32LE(p + 14);
      const size = zip.readUInt32LE(p + 18); // compressed == uncompressed for STORE
      const nameLen = zip.readUInt16LE(p + 26);
      const extraLen = zip.readUInt16LE(p + 28);
      const name = zip.subarray(p + 30, p + 30 + nameLen).toString('utf8');
      const dataStart = p + 30 + nameLen + extraLen;
      entries.push({ name, crc, data: zip.subarray(dataStart, dataStart + size) });
      p = dataStart + size;
    }
    return entries;
  };

  it('every stored entry carries a REAL crc32 of its bytes, and the EOCD is present', () => {
    const zip = renderProfileArchive(buildProfile(XL, projects(1)), 'fixed-id');
    const entries = walkStoredEntries(zip);
    expect(entries.map((e) => e.name)).toContain('FIXED-ID.sdProfile/manifest.json');
    for (const e of entries) {
      const expected = e.data.length ? crc32(e.data) : 0;
      expect(e.crc, `crc for ${e.name}`).toBe(expected); // genuine, not padding
    }
    // End-Of-Central-Directory signature must exist (a truncated archive would lack it).
    expect(zip.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBeGreaterThan(-1);
  });

  it('a byte-flip in an entry breaks the CRC check (the check has teeth)', () => {
    const zip = Buffer.from(renderProfileArchive(buildProfile(XL, projects(1)), 'fixed-id'));
    const manifest = walkStoredEntries(zip).find((e) => e.name.endsWith('manifest.json'))!;
    const flipAt = zip.indexOf(manifest.data) + 1;
    zip.writeUInt8(zip.readUInt8(flipAt) ^ 0xff, flipAt); // corrupt one byte of the manifest payload
    const reparsed = walkStoredEntries(zip).find((e) => e.name.endsWith('manifest.json'))!;
    expect(crc32(reparsed.data)).not.toBe(reparsed.crc); // recomputed CRC no longer matches the stored one
  });
});
