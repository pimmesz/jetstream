import { describe, it, expect } from 'vitest';
import { coordLabel } from './coord';
import { DECK_MODELS, buildGridProfile, gridProfileName } from '../profile';

describe('coordLabel', () => {
  it('labels row by letter (a = top) and column by 1-indexed number', () => {
    expect(coordLabel(0, 0)).toBe('a1'); // top-left
    expect(coordLabel(7, 0)).toBe('a8'); // top-right on an XL
    expect(coordLabel(0, 3)).toBe('d1'); // bottom-left on an XL
    expect(coordLabel(4, 2)).toBe('c5'); // bottom-right on a standard MK.2 (5×3): row c, col 5
  });
});

describe('buildGridProfile', () => {
  it('fills every slot of the deck with a coordinate key', () => {
    const xl = DECK_MODELS.find((d) => d.key === 'xl')!;
    const actions = (buildGridProfile(xl).manifest as { Actions: Record<string, { UUID: string }> })
      .Actions;
    expect(Object.keys(actions)).toHaveLength(xl.cols * xl.rows); // 8 × 4 = 32
    expect(actions['0,0']?.UUID).toBe('gg.pim.jetstream.coord'); // top-left
    expect(actions['7,0']?.UUID).toBe('gg.pim.jetstream.coord'); // top-right (a8)
  });

  it('is a plugin-BUNDLED profile (so a Grid key can switchToProfile to it, no import)', () => {
    const m = buildGridProfile(DECK_MODELS.find((d) => d.key === 'xl')!).manifest as Record<string, unknown>;
    expect(m.InstalledByPluginUUID).toBe('gg.pim.jetstream');
    expect(m.PreconfiguredName).toBe('profiles/Jetstream Grid XL');
    expect(m.Name).toBe('Jetstream Grid XL');
  });
});

describe('gridProfileName', () => {
  it('matches the manifest Profiles[].Name per deck', () => {
    expect(gridProfileName(DECK_MODELS.find((d) => d.key === 'xl')!)).toBe('Jetstream Grid XL');
    expect(gridProfileName(DECK_MODELS.find((d) => d.key === 'mini')!)).toBe('Jetstream Grid Mini');
    expect(gridProfileName(DECK_MODELS.find((d) => d.key === 'standard')!)).toBe('Jetstream Grid');
  });
});
