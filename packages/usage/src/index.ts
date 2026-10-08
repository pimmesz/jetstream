import { randomBytes } from 'node:crypto';
import { link, open, readFile, readdir, writeFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** One rolling window's used percentage (0–100, counts up) + its reset time
 * (epoch SECONDS, as the source reports it). */
export interface UsageWindow {
  usedPct: number;
  resetsAt?: number;
  /** How long the window is, when the source says (Codex does, Claude does not). */
  windowMinutes?: number;
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

/** The long window's label. A window that says how long it is gets its length in days (a Codex free
 * plan's runs 30); without one it is Claude's week. */
export function longWindowLabel(window: UsageWindow): string {
  return window.windowMinutes === undefined ? '7d' : `${Math.round(window.windowMinutes / (24 * 60))}d`;
}

/** Compact one-liner, e.g. `Jetstream · Opus · 5h 34% · 7d 30%`; empty when no data.
 * Used by the statusline hook and available to the plugin. */
export function formatLine(feed: UsageFeed): string {
  if (!feed.available) return '';
  const parts = ['Jetstream'];
  if (feed.model) parts.push(feed.model);
  if (feed.fiveHour) parts.push(`5h ${Math.round(feed.fiveHour.usedPct)}%`);
  if (feed.sevenDay) parts.push(`${longWindowLabel(feed.sevenDay)} ${Math.round(feed.sevenDay.usedPct)}%`);
  return parts.join(' · ');
}

/** Cache path the Jetstream statusline hook writes and the reader reads. */
export function defaultCachePath(home = homedir()): string {
  return join(home, '.jetstream', 'usage.json');
}

/** Persist a feed to the single shared cache file. Kept for a statusline payload without a session
 * id; everything else writes per session (writeSessionCache). Creates the dir; best-effort. */
export async function writeCache(feed: UsageFeed, cachePath = defaultCachePath()): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  // Atomic write (unique temp + rename) so a reader never parses a torn file.
  const tmp = `${cachePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(feed), 'utf8');
  await rename(tmp, cachePath);
}

/** One snapshot file per Claude session. Statusline renders from different sessions run as separate
 * processes, and one shared file made the last renamer win even when it carried an older snapshot. */
export function defaultCacheDir(home = homedir()): string {
  return join(home, '.jetstream', 'usage');
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Older than the longest window (7 days) plus a day: it can say nothing about the current one. */
const MAX_SNAPSHOT_AGE_MS = 8 * 24 * 3600_000;

/** Write this session's snapshot, and drop snapshots too old to matter. */
export async function writeSessionCache(
  feed: UsageFeed,
  sessionId: unknown,
  dir = defaultCacheDir(),
  now = Date.now(),
  legacyPath = defaultCachePath(),
): Promise<void> {
  // No usable session id: keep the old single-file behaviour rather than invent a name.
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return writeCache(feed, legacyPath);
  await writeCache(feed, join(dir, `${sessionId}.json`));
  for (const name of await readdir(dir)) {
    const isAside = name.includes('.json.prune-');
    if (!name.endsWith('.json') && !isAside) continue;
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs <= MAX_SNAPSHOT_AGE_MS) continue;
      // A move-aside copy an interrupted prune left behind: nothing reads it, so it goes once it is old.
      if (isAside) {
        await unlink(path);
        continue;
      }
      // Move it aside before deleting, then look again: its session may have rewritten it between the
      // stat and the move, and a fresh snapshot goes back (a link never overwrites an even newer one).
      const aside = `${path}.prune-${randomBytes(4).toString('hex')}`;
      await rename(path, aside);
      if (now - (await stat(aside)).mtimeMs <= MAX_SNAPSHOT_AGE_MS) {
        try {
          await link(aside, path);
        } catch (error) {
          // An even newer snapshot already took its place: the aside copy is obsolete. Any other failure
          // (EPERM, ENOSPC): keep it under a name of its own, never over a snapshot that may be newer.
          // The reader merges every .json here, and a later prune ages it out.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            await rename(aside, `${path.slice(0, -'.json'.length)}.recovered-${randomBytes(4).toString('hex')}.json`);
            continue;
          }
        }
      }
      await unlink(aside);
    } catch {
      // Another render pruned it first, or a step after the move failed: an aside copy left behind is
      // removed by a later prune once it is old, and a fresh snapshot lost here is rewritten next render.
    }
  }
}

/** Read the cached feed, or null when absent/unreadable/invalid. Never throws. */
export async function readCache(cachePath = defaultCachePath()): Promise<UsageFeed | null> {
  try {
    return parseFeed(JSON.parse(await readFile(cachePath, 'utf8')));
  } catch {
    return null;
  }
}

/** The newer of two readings of the same window: a later reset is a later window; within one
 * window used % only rises, so the higher reading is the newer one. */
function newerWindow(a: UsageWindow | undefined, b: UsageWindow | undefined): UsageWindow | undefined {
  if (!a || !b) return a ?? b;
  if ((a.resetsAt ?? 0) !== (b.resetsAt ?? 0)) return (a.resetsAt ?? 0) > (b.resetsAt ?? 0) ? a : b;
  return a.usedPct >= b.usedPct ? a : b;
}

/** Merge every session snapshot (and the legacy shared file) into one feed. Never throws. */
export async function readMergedCache(
  dir = defaultCacheDir(),
  legacyPath = defaultCachePath(),
  now = Date.now(),
): Promise<UsageFeed | null> {
  const paths = [legacyPath];
  try {
    for (const name of await readdir(dir)) if (name.endsWith('.json')) paths.push(join(dir, name));
  } catch {
    // no per-session snapshots yet
  }
  let merged: UsageFeed | null = null;
  let newest = -1;
  for (const path of paths) {
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > MAX_SNAPSHOT_AGE_MS) continue;
    const feed = await readCache(path);
    if (!feed?.available) continue;
    const base: UsageFeed = merged ?? { source: feed.source, available: true };
    const fiveHour = newerWindow(base.fiveHour, feed.fiveHour);
    const sevenDay = newerWindow(base.sevenDay, feed.sevenDay);
    merged = { ...base, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
    // The model is whatever the most recently written snapshot used.
    if (feed.model && mtime > newest) {
      merged.model = feed.model;
      newest = mtime;
    }
  }
  return merged;
}

/** A window whose reset time has passed says nothing about the current one except that it restarted. */
export function freshen(feed: UsageFeed, now = Date.now()): UsageFeed {
  const reset = (w: UsageWindow | undefined): UsageWindow | undefined => {
    if (!w || w.resetsAt === undefined || w.resetsAt * 1000 > now) return w;
    // Drop the reset time that already passed, but keep the window's length for its label.
    const { resetsAt: _passed, ...rest } = w;
    return { ...rest, usedPct: 0 };
  };
  const fiveHour = reset(feed.fiveHour);
  const sevenDay = reset(feed.sevenDay);
  const { fiveHour: _f, sevenDay: _s, ...rest } = feed;
  return { ...rest, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

export interface ResolveDeps {
  readCacheFn?: () => Promise<UsageFeed | null>;
  now?: number;
}

/** Resolve the current Claude usage from the statusline snapshots, or an explicit unavailable feed
 * when there's no data yet. Never throws. */
export async function resolveUsage(deps: ResolveDeps = {}): Promise<UsageFeed> {
  const cached = await (deps.readCacheFn ?? (() => readMergedCache()))();
  if (cached?.available) return freshen(cached, deps.now);
  return {
    source: 'claude',
    available: false,
    note: 'no usage yet — install the Jetstream statusline hook (`jetstream hooks install`)',
  };
}

// --- Codex -------------------------------------------------------------------------------------

/** How much of a rollout file's end is read: a token_count line is a few hundred bytes, and the
 * newest one is near the end of a file that can run to tens of megabytes. */
const ROLLOUT_TAIL_BYTES = 256 * 1024;
/** How many files with an account reading are compared, and how many files are read at most to find
 * them: files holding only per-model buckets (an auto-review session) do not count toward the first. */
const ROLLOUT_FILES = 8;
const ROLLOUT_FILES_READ = 64;

/** Codex logs every session to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, and each
 * `token_count` event carries the account's rate limits. Reading that log needs no login and no
 * network, the same subscription-only rule the Claude side keeps. */
export function codexSessionsDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'sessions');
}

async function numericDesc(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => /^\d+$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

/** The most recently written rollout files. Every day folder is scanned: a session started long ago
 * that is still running keeps writing into its START day, so recency is the file's mtime, never its
 * folder. A stat per file is cheap (a heavy user has a few thousand). */
async function newestRollouts(root: string): Promise<string[]> {
  const files: Array<{ path: string; mtime: number }> = [];
  for (const y of await numericDesc(root)) {
    for (const m of await numericDesc(join(root, y))) {
      for (const d of await numericDesc(join(root, y, m))) {
        const day = join(root, y, m, d);
        let names: string[] = [];
        try {
          names = (await readdir(day)).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const name of names) {
          try {
            files.push({ path: join(day, name), mtime: (await stat(join(day, name))).mtimeMs });
          } catch {
            // rotated away mid-scan
          }
        }
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, ROLLOUT_FILES_READ)
    .map((f) => f.path);
}

/** The account's last `rate_limits` object in a rollout file, with when it was logged, read from its tail only. */
async function lastRateLimits(path: string): Promise<{ limits: Record<string, unknown>; at: number } | undefined> {
  let text: string;
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } finally {
    await handle.close();
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    try {
      const entry = asRecord(JSON.parse(line));
      const limits = asRecord(asRecord(entry?.payload)?.rate_limits);
      // Codex also logs per-model buckets (limit_id `codex_bengalfox` for Spark): only `codex` is the
      // account's. An older log without a limit_id has only the account's.
      if (typeof limits?.limit_id === 'string' && limits.limit_id !== 'codex') continue;
      if (limits && (asRecord(limits.primary) || asRecord(limits.secondary))) {
        const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
        return { limits, at: Number.isFinite(at) ? at : 0 };
      }
    } catch {
      // the first line of the tail is usually cut in half
    }
  }
  return undefined;
}

/** Turn Codex's `rate_limits` into the feed. A window of a day or less is the short one. Pure. */
export function parseCodexRateLimits(raw: unknown): UsageFeed {
  const limits = asRecord(raw);
  const feed: UsageFeed = { source: 'codex', available: false };
  for (const key of ['primary', 'secondary']) {
    const w = asRecord(limits?.[key]);
    const window = toWindow(w?.used_percent, w?.resets_at);
    const minutes = finite(w?.window_minutes);
    if (!window || minutes === undefined) continue;
    if (minutes <= 24 * 60) feed.fiveHour = { ...window, windowMinutes: minutes };
    else feed.sevenDay = { ...window, windowMinutes: minutes };
  }
  feed.available = feed.fiveHour !== undefined || feed.sevenDay !== undefined;
  if (!feed.available) feed.note = 'Codex logged no usable rate-limit window';
  return feed;
}

export interface CodexDeps {
  sessionsDir?: string;
  now?: number;
}

/** Resolve the current Codex usage from its newest session logs. Never throws. */
export async function resolveCodexUsage(deps: CodexDeps = {}): Promise<UsageFeed> {
  try {
    // A file's mtime moves with any event, so among the newest files take the reading that was
    // LOGGED last: another session may have appended tool output after an older reading.
    let best: { limits: Record<string, unknown>; at: number } | undefined;
    let filesWithReading = 0;
    for (const path of await newestRollouts(deps.sessionsDir ?? codexSessionsDir())) {
      if (filesWithReading >= ROLLOUT_FILES) break;
      // One file vanishing (rotated or deleted mid-scan) must not cost the readings already found.
      const found = await lastRateLimits(path).catch(() => undefined);
      if (!found || !parseCodexRateLimits(found.limits).available) continue;
      filesWithReading++;
      if (!best || found.at > best.at) best = found;
    }
    if (best) return freshen(parseCodexRateLimits(best.limits), deps.now);
  } catch {
    // unreadable logs: report no data below
  }
  return { source: 'codex', available: false, note: 'no Codex usage yet; run `codex` once' };
}
