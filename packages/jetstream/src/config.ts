import type { Theme } from '@pimmesz/jetstream-status';

/** Plugin-wide settings, stored in Stream Deck global settings and edited via the
 * Jetstream Settings key. (The loopback port is NOT here — the hook scripts are
 * separate processes that read `JETSTREAM_PORT`/the default, so plugin and hooks
 * agree via env, not plugin settings.) */
// A type alias (not interface) so it satisfies the SDK's JsonObject settings constraint.
export type JetstreamConfig = {
  theme: Theme;
  longPressMs: number;
  usageRefreshSec: number;
  escalateAfterSec: number;
};

export const DEFAULTS: JetstreamConfig = {
  theme: 'default',
  longPressMs: 500,
  usageRefreshSec: 60,
  escalateAfterSec: 120,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Merge raw settings over a base, defensively (bad/missing fields fall back to the base).
 * The base defaults to `DEFAULTS`, but the config-file preset can raise it (see
 * `ConfigStore.setBase`) so a fresh install's file preset isn't erased by an empty or
 * partial global-settings object. Pure. */
export function mergeConfig(raw: unknown, base: JetstreamConfig = DEFAULTS): JetstreamConfig {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    theme: r.theme === 'highContrast' || r.theme === 'default' ? r.theme : base.theme,
    longPressMs: clampInt(r.longPressMs, base.longPressMs, 200, 3000),
    usageRefreshSec: clampInt(r.usageRefreshSec, base.usageRefreshSec, 15, 3600),
    escalateAfterSec: clampInt(r.escalateAfterSec, base.escalateAfterSec, 15, 3600),
  };
}

/** Live config singleton. Priority is: live global settings (the Settings key) > the
 * optional `projects.json` preset > `DEFAULTS`. Global settings merge over the preset base,
 * not straight over DEFAULTS, so a partial/empty global-settings object can't silently
 * revert the file preset. */
class ConfigStore {
  private base: JetstreamConfig = DEFAULTS;
  private raw: unknown = undefined;
  private value: JetstreamConfig = DEFAULTS;
  private listeners = new Set<() => void>();

  get(): JetstreamConfig {
    return this.value;
  }

  /** Set the baseline that live global settings merge over: the optional `projects.json`
   * `settings` preset, itself layered over DEFAULTS. Call once at startup, before the first
   * `set()`, so a fresh install can pin theme/timings while a runtime Settings-key edit
   * (a complete global-settings object) still wins. */
  setBase(preset: unknown): void {
    this.base = mergeConfig(preset, DEFAULTS);
    this.recompute();
  }

  set(raw: unknown): void {
    this.raw = raw;
    this.recompute();
  }

  private recompute(): void {
    this.value = mergeConfig(this.raw, this.base);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const config = new ConfigStore();
