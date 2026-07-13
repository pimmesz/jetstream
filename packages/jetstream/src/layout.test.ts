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

  it('places a Jetstream project key (with settings) and a no-settings key', () => {
    const { placements } = resolvePlacements(xl, [
      { coord: 'b1', type: 'project', path: '/dev/falcon', name: 'Falcon' },
      { coord: 'c1', type: 'usage' },
    ]);
    expect(placements[0]).toMatchObject({ uuid: 'gg.pim.jetstream.project', settings: { path: '/dev/falcon', name: 'Falcon' } });
    expect(placements[1]).toMatchObject({ uuid: 'gg.pim.jetstream.usage', settings: null });
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
    expect(m.Actions['0,0']?.UUID).toBe('gg.pim.jetstream.fleet');
    // Every other coordinate is filled with an empty self-labeling slot → the whole XL is plugin-owned.
    expect(Object.keys(m.Actions)).toHaveLength(xl.cols * xl.rows);
    expect(m.Actions['3,2']).toMatchObject({ UUID: 'gg.pim.jetstream.slot', Settings: { kind: 'empty' } });
  });
});
