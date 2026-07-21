import { describe, it, expect } from 'vitest';
import { mergeConfig, DEFAULTS } from './config';

describe('mergeConfig', () => {
  it('returns defaults for empty/garbage input', () => {
    expect(mergeConfig(undefined)).toEqual(DEFAULTS);
    expect(mergeConfig('nope')).toEqual(DEFAULTS);
    expect(mergeConfig({ theme: 'bogus', port: 'x', longPressMs: 'nope' })).toEqual(DEFAULTS);
  });

  it('applies valid overrides and clamps out-of-range numbers', () => {
    expect(mergeConfig({ theme: 'highContrast' }).theme).toBe('highContrast');
    expect(mergeConfig({ longPressMs: 800 }).longPressMs).toBe(800);
    expect(mergeConfig({ longPressMs: 99 }).longPressMs).toBe(200); // clamped to min
    expect(mergeConfig({ escalateAfterSec: 99999 }).escalateAfterSec).toBe(3600); // clamped to max
  });


});

describe('mergeConfig with a base preset (G3 file preset)', () => {
  it('falls back to the base for missing fields (not DEFAULTS)', () => {
    const base = mergeConfig({ theme: 'highContrast', longPressMs: 800 });
    const merged = mergeConfig({}, base);
    expect(merged.theme).toBe('highContrast');
    expect(merged.longPressMs).toBe(800);
    expect(merged.usageRefreshSec).toBe(DEFAULTS.usageRefreshSec);
  });

  it('lets a raw override win over the base', () => {
    const base = mergeConfig({ theme: 'highContrast' });
    expect(mergeConfig({ theme: 'default' }, base).theme).toBe('default');
  });
});
