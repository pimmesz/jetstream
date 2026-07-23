import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** One rolling window's used percentage (0–100, counts up) + its reset time
 * (epoch SECONDS, as the source reports it). */
export interface UsageWindow {
  usedPct: number;
  resetsAt?: number;
}

/** The structured usage feed the deck renders. A window with no data is omitted;
 * `available` is false when nothing usable could be read (`note` says why). */
export interface UsageFeed {
  source: string;
  model?: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  available: boolean;
  note?: string;
}

/** Clamp a used-% to 0–100; undefined when not a finite number. */
export function clampPct(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toWindow(usedPct: unknown, resetsAt: unknown): UsageWindow | undefined {
  const pct = clampPct(usedPct);
  if (pct === undefined) return undefined;
  const reset = finite(resetsAt);
  return reset === undefined ? { usedPct: pct } : { usedPct: pct, resetsAt: reset };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse a Claude Code statusline payload (the JSON piped to a statusline hook) into
 * the feed. Defensive: an unknown/garbage shape yields `{ available: false }` rather
 * than throwing. Payload: `{ model?:{display_name}, rate_limits?:{ five_hour?:
 * {used_percentage,resets_at}, seven_day?:{...} } }` (resets_at = epoch seconds). */
export function parseClaudeStatusline(raw: unknown): UsageFeed {
  const root = asRecord(raw);
  const model = asRecord(root?.model);
  const displayName = typeof model?.display_name === 'string' ? model.display_name : undefined;
  const limits = asRecord(root?.rate_limits);
  const fiveHour = toWindow(asRecord(limits?.five_hour)?.used_percentage, asRecord(limits?.five_hour)?.resets_at);
  const sevenDay = toWindow(asRecord(limits?.seven_day)?.used_percentage, asRecord(limits?.seven_day)?.resets_at);
  const available = fiveHour !== undefined || sevenDay !== undefined;
  const feed: UsageFeed = { source: 'claude', available };
  if (displayName) feed.model = displayName;
  if (fiveHour) feed.fiveHour = fiveHour;
  if (sevenDay) feed.sevenDay = sevenDay;
  if (!available) feed.note = 'statusline payload carried no usable rate-limit window';
  return feed;
}

/** Validate/coerce a persisted feed read back from the cache (untrusted disk). */
export function parseFeed(raw: unknown): UsageFeed | null {
  const root = asRecord(raw);
  if (!root || typeof root.source !== 'string' || typeof root.available !== 'boolean') return null;
  const feed: UsageFeed = { source: root.source, available: root.available };
  if (typeof root.model === 'string') feed.model = root.model;
  const fiveHour = toWindow(asRecord(root.fiveHour)?.usedPct, asRecord(root.fiveHour)?.resetsAt);
  const sevenDay = toWindow(asRecord(root.sevenDay)?.usedPct, asRecord(root.sevenDay)?.resetsAt);
  if (fiveHour) feed.fiveHour = fiveHour;
  if (sevenDay) feed.sevenDay = sevenDay;
  if (typeof root.note === 'string') feed.note = root.note;
  return feed;
}

/** Compact one-liner, e.g. `Jetstream · Opus · 5h 34% · 7d 30%`; empty when no data.
 * Used by the statusline hook and available to the plugin. */
export function formatLine(feed: UsageFeed): string {
  if (!feed.available) return '';
  const parts = ['Jetstream'];
  if (feed.model) parts.push(feed.model);
  if (feed.fiveHour) parts.push(`5h ${Math.round(feed.fiveHour.usedPct)}%`);
  if (feed.sevenDay) parts.push(`7d ${Math.round(feed.sevenDay.usedPct)}%`);
  return parts.join(' · ');
}

/** Cache path the Jetstream statusline hook writes and the reader reads. */
export function defaultCachePath(home = homedir()): string {
  return join(home, '.jetstream', 'usage.json');
}

/** Persist a feed to the cache (used by the hook). Creates the dir; best-effort. */
export async function writeCache(feed: UsageFeed, cachePath = defaultCachePath()): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  // Atomic write (temp-per-pid + rename) so two concurrent statusline-hook processes can't tear the
  // JSON the reader parses — mirrors fleet.ts / state.ts. Readers already tolerate an absent file.
  const tmp = `${cachePath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(feed), 'utf8');
  await rename(tmp, cachePath);
}

/** Read the cached feed, or null when absent/unreadable/invalid. Never throws. */
export async function readCache(cachePath = defaultCachePath()): Promise<UsageFeed | null> {
  try {
    return parseFeed(JSON.parse(await readFile(cachePath, 'utf8')));
  } catch {
    return null;
  }
}

export interface ResolveDeps {
  readCacheFn?: (cachePath?: string) => Promise<UsageFeed | null>;
}

/** Resolve the current usage from the Jetstream statusline cache, or an explicit unavailable
 * feed when there's no data yet. Never throws. */
export async function resolveUsage(deps: ResolveDeps = {}): Promise<UsageFeed> {
  const cached = await (deps.readCacheFn ?? readCache)();
  if (cached?.available) return cached;
  return {
    source: 'claude',
    available: false,
    note: 'no usage yet — install the Jetstream statusline hook (`jetstream hooks install`)',
  };
}
