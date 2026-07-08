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
