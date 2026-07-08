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

/** Merge raw global settings over the defaults, defensively (bad/missing fields fall
 * back to the default). Pure. */
export function mergeConfig(raw: unknown): JetstreamConfig {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    theme: r.theme === 'highContrast' ? 'highContrast' : 'default',
    longPressMs: clampInt(r.longPressMs, DEFAULTS.longPressMs, 200, 3000),
    usageRefreshSec: clampInt(r.usageRefreshSec, DEFAULTS.usageRefreshSec, 15, 3600),
    escalateAfterSec: clampInt(r.escalateAfterSec, DEFAULTS.escalateAfterSec, 15, 3600),
  };
}

/** Live config singleton, refreshed from Stream Deck global settings. */
class ConfigStore {
  private value: JetstreamConfig = DEFAULTS;
  private listeners = new Set<() => void>();

  get(): JetstreamConfig {
    return this.value;
  }

  set(raw: unknown): void {
    this.value = mergeConfig(raw);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const config = new ConfigStore();
