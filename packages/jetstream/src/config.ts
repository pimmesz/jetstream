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
  /** Branch namespace whose open PRs the CI key watches. Defaults to afterburner's, but
   * a non-afterburner user sets their own so the CI key isn't stuck on "no PRs". */
  ciBranchPrefix: string;
  /** Global model override the Launch keys fall back to when their own `model` is unset,
   * cycled by the Model key. Plain string (a `claude -p` alias); '' = no override. */
  launchModel: string;
  /** Whether a slot's `run` kind may EXECUTE its command on press. OFF by default: the loopback
   * `/slot` endpoint is unauthenticated, so a local process could plant a `run` command; keeping
   * execution opt-in means a planted command is inert until the user deliberately enables this. */
  allowRunKeys: boolean;
};

export const DEFAULTS: JetstreamConfig = {
  theme: 'default',
  longPressMs: 1000,
  usageRefreshSec: 60,
  escalateAfterSec: 300,
  ciBranchPrefix: 'afterburner/',
  launchModel: '',
  allowRunKeys: false,
};

/** The accepted range per numeric setting — single-sourced so the init wizard can
 * validate what mergeConfig would otherwise silently clamp at runtime. */
export const LIMITS = {
  longPressMs: { min: 200, max: 3000 },
  usageRefreshSec: { min: 15, max: 3600 },
  escalateAfterSec: { min: 15, max: 3600 },
} as const;

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
    longPressMs: clampInt(r.longPressMs, base.longPressMs, LIMITS.longPressMs.min, LIMITS.longPressMs.max),
    usageRefreshSec: clampInt(r.usageRefreshSec, base.usageRefreshSec, LIMITS.usageRefreshSec.min, LIMITS.usageRefreshSec.max),
    escalateAfterSec: clampInt(r.escalateAfterSec, base.escalateAfterSec, LIMITS.escalateAfterSec.min, LIMITS.escalateAfterSec.max),
    ciBranchPrefix:
      typeof r.ciBranchPrefix === 'string' && r.ciBranchPrefix.trim() !== ''
        ? r.ciBranchPrefix.trim()
        : base.ciBranchPrefix,
    launchModel: typeof r.launchModel === 'string' ? r.launchModel.trim() : base.launchModel,
    allowRunKeys: typeof r.allowRunKeys === 'boolean' ? r.allowRunKeys : base.allowRunKeys,
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
