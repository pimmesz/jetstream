import { describe, it, expect } from 'vitest';
import { config, mergeConfig, DEFAULTS } from './config';

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
    expect(mergeConfig({ usageRefreshSec: 1 }).usageRefreshSec).toBe(15); // clamped to min
    expect(mergeConfig({ usageRefreshSec: 99999 }).usageRefreshSec).toBe(3600); // clamped to max
  });

  // These two flags gate whether the UNAUTHENTICATED loopback /slot endpoint may run an arbitrary
  // command or SIGINT the whole fleet. plugin.ts routes live settings straight through mergeConfig,
  // so its `typeof === 'boolean'` guard IS the defense: without it, a planted truthy non-boolean
  // (`"true"`, `1`) would fall through and open the gate. Nothing exercised this before.
  it('honours the two destructive-key opt-ins only when they are a real boolean', () => {
    expect(mergeConfig({ allowRunKeys: true }).allowRunKeys).toBe(true);
    expect(mergeConfig({ allowStopKeys: true }).allowStopKeys).toBe(true);
    // A truthy non-boolean must NOT open the gate — this is the security-relevant branch.
    expect(mergeConfig({ allowStopKeys: 'true' }).allowStopKeys).toBe(false);
    expect(mergeConfig({ allowRunKeys: 1 }).allowRunKeys).toBe(false);
    // Default is closed; an explicit false stays closed.
    expect(mergeConfig({}).allowStopKeys).toBe(false);
    expect(mergeConfig({ allowStopKeys: false }).allowStopKeys).toBe(false);
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

// The live singleton, not just the pure merge — the end-to-end path a projects.json preset takes
// (setBase) and the 'live global settings > file preset > DEFAULTS' contract. Nothing tested this,
// so dropping setBase's effect stayed green while a user's preset never reached the key gates and
// the stop-all key sat inert with a face telling them to enable it.
describe('config singleton (setBase precedence)', () => {
  it('a projects.json preset reaches config.get(), and a runtime edit wins WITHOUT wiping the preset', () => {
    try {
      // A fresh preset from the file: enable stop-all keys and pick a theme.
      config.setBase({ allowStopKeys: true, theme: 'highContrast' });
      expect(config.get().allowStopKeys).toBe(true);
      expect(config.get().theme).toBe('highContrast');

      // A Settings-key edit changes the theme at runtime — it must win, but must NOT silently
      // revert the preset's allowStopKeys (the regression the layered merge prevents).
      config.set({ theme: 'default' });
      expect(config.get().theme).toBe('default'); // live wins
      expect(config.get().allowStopKeys).toBe(true); // preset survives
    } finally {
      // In a finally so a mid-test assertion failure can't leak allowStopKeys=true into siblings.
      config.setBase(undefined);
      config.set(undefined);
    }
  });
});
