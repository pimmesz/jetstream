import { describe, it, expect } from 'vitest';
import { parseCoord, resolvePlacements } from './layout';
import { DECK_MODELS, buildLayoutProfile } from './profile';

const xl = DECK_MODELS.find((d) => d.key === 'xl')!;

describe('parseCoord', () => {
  it('maps row=letter (a=top) and col=1-indexed number', () => {
    expect(parseCoord('a1', xl)).toEqual({ column: 0, row: 0 }); // top-left
    expect(parseCoord('a8', xl)).toEqual({ column: 7, row: 0 }); // top-right
    expect(parseCoord('d1', xl)).toEqual({ column: 0, row: 3 }); // bottom-left
    expect(parseCoord('B3', xl)).toEqual({ column: 2, row: 1 }); // case-insensitive
  });

  it('rejects off-board and unparseable coordinates', () => {
    expect(parseCoord('a9', xl)).toBeNull(); // col 9 > 8
    expect(parseCoord('e1', xl)).toBeNull(); // row e > d (only 4 rows)
    expect(parseCoord('8a', xl)).toBeNull();
    expect(parseCoord('', xl)).toBeNull();
  });
});

describe('resolvePlacements', () => {
  it('builds an open-app key as a plugin-owned slot (kind app), so it can be retargeted live', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'a8', type: 'open-app', app: '/Applications/Telegram.app' },
    ]);
    expect(placements).toEqual([
      {
        column: 7,
        row: 0,
        uuid: 'gg.pim.jetstream.slot',
        name: 'App',
        settings: { kind: 'app', app: '/Applications/Telegram.app' },
      },
    ]);
  });

  it('rejects a non-http(s) open-url, matching the runtime execPlan guard', () => {
    const { placements, warnings } = resolvePlacements(xl, [{ coord: 'a1', type: 'open-url', url: 'file:///etc/passwd' }]);
    expect(placements).toHaveLength(0);
    expect(warnings[0]).toMatch(/http/i);
  });

  it('threads cosmetic overrides (colour normalized, sub, glyph) onto a slot key', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'a8', type: 'open-app', app: '/Applications/Telegram.app', color: 'red', sub: 'chat', glyph: '🚀' },
    ]);
    expect(placements[0]?.settings).toMatchObject({ kind: 'app', color: '#e5484d', sub: 'chat', glyph: '🚀' });
  });

  it('builds a run slot with a pre-split argv (never a shell string)', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'b1', type: 'run', command: 'code', args: ['~/dev', 3, 'x'], label: 'Edit' },
    ]);
    expect(placements[0]).toMatchObject({
      uuid: 'gg.pim.jetstream.slot',
      settings: { kind: 'run', command: 'code', args: ['~/dev', 'x'], label: 'Edit' }, // non-string arg dropped
    });
  });

  it('folds a project key into a LIVE slot kind (uuid slot → sendSlot, no import) alongside a no-settings key', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'b1', type: 'project', path: '/dev/falcon', name: 'Falcon' },
      { coord: 'c1', type: 'usage' },
    ]);
    // uuid === gg.pim.jetstream.slot is exactly what puts a repo add in cli.ts onLayout's LIVE bucket
    // (structural.length === 0) instead of forcing a .streamDeckProfile re-import.
    expect(placements[0]).toMatchObject({
      uuid: 'gg.pim.jetstream.slot',
      settings: { kind: 'project', path: '/dev/falcon', name: 'Falcon' },
    });
    expect(placements[1]).toMatchObject({ uuid: 'gg.pim.jetstream.usage', settings: null });
  });

  it('a project key requires a path, and threads cosmetic overrides onto the slot', () => {
    const { placements, warnings } = resolvePlacements(xl, [
      { coord: 'a1', type: 'project' }, // no path → dropped with a warning
      { coord: 'b1', type: 'project', path: '/dev/x', color: 'red', label: 'X' },
    ]);
    expect(warnings.some((w) => /project needs "path"/.test(w))).toBe(true);
    expect(placements).toHaveLength(1);
    expect(placements[0]?.settings).toMatchObject({ kind: 'project', path: '/dev/x', color: '#e5484d', label: 'X' });
  });

  it('places a mic-mute key (a no-settings action wired into the designer)', () => {
    const { placements, warnings } = resolvePlacements(xl, [{ coord: 'd2', type: 'micmute' }]);
    expect(warnings).toHaveLength(0); // no longer an "unknown key type"
    expect(placements[0]).toMatchObject({ column: 1, row: 3, uuid: 'gg.pim.jetstream.micmute', settings: null });
  });

  it('folds build + stop-all + model + fleet into LIVE slot kinds (uuid slot → sendSlot, no import)', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'd1', type: 'stop-all' },
      { coord: 'd2', type: 'build' },
      { coord: 'd3', type: 'model' },
      { coord: 'd4', type: 'fleet' },
    ]);
    // uuid === gg.pim.jetstream.slot is exactly what puts them in cli.ts onLayout's LIVE bucket
    // (structural.length === 0) instead of forcing a .streamDeckProfile re-import.
    expect(placements[0]).toMatchObject({ uuid: 'gg.pim.jetstream.slot', settings: { kind: 'stopall' } });
    expect(placements[1]).toMatchObject({ uuid: 'gg.pim.jetstream.slot', settings: { kind: 'build' } });
    expect(placements[2]).toMatchObject({ uuid: 'gg.pim.jetstream.slot', settings: { kind: 'model' } });
    expect(placements[3]).toMatchObject({ uuid: 'gg.pim.jetstream.slot', settings: { kind: 'fleet' } });
  });

  it('places volume keys as live slot kinds (volup/voldown/volmute)', () => {
    const { placements, warnings } = resolvePlacements(xl, [
      { coord: 'd6', type: 'volup' },
      { coord: 'd7', type: 'voldown' },
      { coord: 'd8', type: 'volmute' },
    ]);
    expect(warnings).toHaveLength(0);
    expect(placements.map((p) => (p.settings as { kind?: string } | null)?.kind)).toEqual(['volup', 'voldown', 'volmute']);
    expect(placements.every((p) => p.uuid === 'gg.pim.jetstream.slot')).toBe(true);
  });

  it('drops — with a warning each — unknown types, off-board coords, dupes, and missing settings', () => {
    const { placements, warnings } = resolvePlacements(xl, [
      { coord: 'a1', type: 'open-app' }, // missing app
      { coord: 'z9', type: 'usage' }, // off-board
      { coord: 'a2', type: 'nope' }, // unknown type
      { coord: 'b2', type: 'usage' }, // ok
      { coord: 'b2', type: 'fleet' }, // duplicate coordinate
    ]);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ column: 1, row: 1, uuid: 'gg.pim.jetstream.usage' });
    expect(warnings).toHaveLength(4);
  });
});

describe('buildLayoutProfile', () => {
  it('emits an importable profile placing each key at its coordinate', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'a8', type: 'open-app', app: '/Applications/Telegram.app' },
      { coord: 'a1', type: 'fleet' },
    ]);
    const m = buildLayoutProfile(xl, placements).manifest as {
      Actions: Record<string, { UUID: string; Settings: unknown }>;
      DeviceModel: string;
    };
    expect(m.DeviceModel).toBe(xl.model);
    expect(m.Actions['7,0']).toMatchObject({
      UUID: 'gg.pim.jetstream.slot',
      Settings: { kind: 'app', app: '/Applications/Telegram.app' },
    });
    // fleet is now FOLDED into a live slot kind (so it moves live) rather than a native fleet action.
    expect(m.Actions['0,0']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'fleet' } });
    // Every other coordinate is filled with an empty self-labeling slot → the whole XL is plugin-owned.
    expect(Object.keys(m.Actions)).toHaveLength(xl.cols * xl.rows);
    expect(m.Actions['3,2']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } });
  });
});
