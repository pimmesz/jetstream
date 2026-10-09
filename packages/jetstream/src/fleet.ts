import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { JetstreamConfig } from './config';
import { isDeepStrictEqual } from 'node:util';
import { writeFileAtomicSync } from './atomic-write';
import { readConfigFile } from './projects-config';
import { errorMessage } from './errors';

/**
 * The single source of the fleet rules — how a project is added, deduped, named, and
 * how projects.json is rendered/written. Deliberately dependency-light (no readline, no
 * profile generation, no Stream Deck SDK) so BOTH the terminal wizard (`init.ts`) and the
 * in-app Settings property inspector (via `handleFleetMessage`) share one implementation
 * and can't drift.
 */

/** How many timestamped fleet backups to keep beside projects.json. */
const BACKUPS_KEPT = 5;

/** Drop control characters (ANSI escapes included) from text bound for a terminal. The one copy:
 * init.ts and board-layout.ts use it too, so a widened range lands everywhere at once. */
export const stripControl = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, '');

/** `~` and `~/x` → the user's home; anything else unchanged. Used before a scan so a
 * typed `~/dev` resolves (readdirSync doesn't expand tildes). */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Resolve symlinks/case aliases so dedup can't be fooled into duplicate fleet entries
 * for the same repo; a path that doesn't resolve (yet) stays as typed. */
export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Derive a unique, url-ish project id from a display name: lowercase, runs of
 * non-alphanumerics collapse to '-', uniquified with -2/-3/… against `taken`. */
export function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Directory names never worth descending into when hunting for repos: package installs,
 * the macOS Library/Applications trees, and the Trash. Hidden dirs (a `.` prefix) are skipped
 * separately — that's what keeps `.nvm` / `.oh-my-zsh` out of the results. */
const SCAN_SKIP = new Set(['node_modules', 'Library', 'Applications', '.Trash']);

/** Find git repo roots under `dir`, searched a few levels deep (so pointing at your HOME
 * folder finds `~/Personal/app`, `~/work/api`, `~/Capgemini/foo/bar`, not just direct
 * children). Skips hidden dirs and heavy noise, and never descends INTO a repo (its subdirs
 * aren't separate repos). Unreadable dirs are skipped; results are deduped + sorted. */
export function scanForGitRepos(dir: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, gone) — skip, never throw
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SCAN_SKIP.has(entry.name)) continue;
      const child = join(current, entry.name);
      if (existsSync(join(child, '.git'))) {
        found.push(child); // a repo root — stop; don't treat its subdirs as repos
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(dir, 1);
  return [...new Set(found)].sort();
}

/** Render projects.json: pretty, stable field order, `settings` omitted entirely when
 * empty (a clean file documents only choices). */
export function renderProjectsJson(
  projects: ProjectConfig[],
  settings: Partial<JetstreamConfig>,
): string {
  const file: Record<string, unknown> = {
    projects: projects.map(({ id, name, path }) => ({ id, name, path })),
  };
  if (Object.keys(settings).length > 0) file.settings = settings;
  return `${JSON.stringify(file, null, 2)}\n`;
}

export interface FleetAddResult {
  projects: ProjectConfig[];
  /** The added entry, present only when a new project was actually appended. */
  added?: ProjectConfig;
  /** Why nothing was added, when `added` is absent. */
  reason?: 'duplicate' | 'empty-path';
}

/** Add a project to the fleet, applying the canonical rules once: strip control bytes,
 * canonicalize the path, dedup by resolved path, derive a unique id, fall back the name
 * to the folder's basename. Pure — returns a new list; never mutates the input. */
export function addToFleet(
  projects: ProjectConfig[],
  input: { path: string; name?: string },
): FleetAddResult {
  // expandHome so a typed `~/dev/falcon` (the in-app add field) resolves; idempotent for
  // the CLI, which already passes an absolute path. Then canonicalize + dedup.
  const path = canonical(expandHome(stripControl(input.path).trim()));
  if (!path) return { projects, reason: 'empty-path' };
  // Canonical on both sides: a hand-written `repo/` or symlinked entry is the same repo.
  if (projects.some((p) => canonical(p.path) === path)) return { projects, reason: 'duplicate' };
  const taken = new Set(projects.map((p) => p.id));
  const name = stripControl(input.name ?? '').trim() || basename(path) || 'project';
  const added: ProjectConfig = { id: slugId(name, taken), name, path };
  return { projects: [...projects, added], added };
}

/** Remove the project with `id` from the fleet. Pure. */
export function removeFromFleet(projects: ProjectConfig[], id: string): ProjectConfig[] {
  return projects.filter((p) => p.id !== id);
}

export interface FleetSnapshot {
  projects: ProjectConfig[];
  settings: Partial<JetstreamConfig>;
}

/**
 * Replay one writer's change (what it read as `base`, what it wants as `next`) onto the file as it is
 * on disk NOW. projects.json has three writers in separate processes; writing `next` wholesale let
 * one writer's stale read silently drop another's add or remove. Only what this writer changed is
 * applied: its removals are removed, its adds and edits upserted, its changed settings set; every
 * other entry on disk is kept. Entries are tracked by id, as the editor removes them, so one of two
 * spellings of the same repo can go; an add or edit lands on the disk entry with its canonical
 * path. Pure.
 */
export function replayFleetDelta(disk: FleetSnapshot, base: FleetSnapshot, next: FleetSnapshot): FleetSnapshot {
  const key = (p: ProjectConfig): string => canonical(p.path);
  const before = new Map(base.projects.map((p) => [p.id, p]));
  const nextIds = new Set(next.projects.map((p) => p.id));
  const removed = base.projects.filter((p) => !nextIds.has(p.id));
  // Path checked too, so an id another writer has since given to a different repo is left alone.
  const projects = disk.projects.filter(
    (p) => !removed.some((r) => r.id === p.id && key(r) === key(p)),
  );
  for (const p of next.projects) {
    const was = before.get(p.id);
    if (was && was.name === p.name && key(was) === key(p)) continue; // untouched by this writer
    const at = projects.findIndex((q) => key(q) === key(p));
    // Ids must stay unique (the reader drops a duplicate): another writer may have added a different
    // repo under the same id meanwhile, so the newcomer gets a fresh one.
    const taken = new Set(projects.filter((_, i) => i !== at).map((q) => q.id));
    const entry = taken.has(p.id) ? { ...p, id: slugId(p.name, taken) } : p;
    if (at >= 0) projects[at] = entry;
    else projects.push(entry);
  }
  const settings: Record<string, unknown> = { ...disk.settings };
  const baseSettings = base.settings as Record<string, unknown>;
  for (const [k, v] of Object.entries(next.settings)) {
    if (!isDeepStrictEqual(v, baseSettings[k])) settings[k] = v;
  }
  for (const k of Object.keys(baseSettings)) if (!(k in next.settings)) delete settings[k];
  return { projects, settings: settings as Partial<JetstreamConfig> };
}

/** Write projects.json atomically (same-dir temp + rename), preserving the settings block.
 * projects.json is jetstream's own file; a crash mid-write can't truncate it. Pass `base` (the
 * snapshot this writer read before editing) and only its own change is replayed onto the file as it
 * is right now (replayFleetDelta); without `base` the file is replaced wholesale. Waiting for the
 * lock blocks the thread, which the CLI can afford; the plugin uses writeFleetFileAsync. */
export function writeFleetFile(
  path: string,
  projects: ProjectConfig[],
  settings: Partial<JetstreamConfig> = {},
  now: Date = new Date(),
  base?: FleetSnapshot,
  lockWaitMs: number = FLEET_LOCK_WAIT_MS,
): FleetSnapshot {
  // One writer at a time from the re-read to the rename, so the replay always starts from the file
  // the rename will replace.
  return withFleetLock(`${path}.lock`, lockWaitMs, () => replayAndWrite(path, projects, settings, now, base));
}

/** The same write as writeFleetFile, but it waits for the lock without blocking the thread, so the
 * plugin's keys and hooks keep running while another writer finishes. */
export function writeFleetFileAsync(
  path: string,
  projects: ProjectConfig[],
  settings: Partial<JetstreamConfig>,
  now: Date,
  base?: FleetSnapshot,
  lockWaitMs: number = FLEET_LOCK_WAIT_MS,
): Promise<FleetSnapshot> {
  return withFleetLockAsync(`${path}.lock`, lockWaitMs, () => replayAndWrite(path, projects, settings, now, base));
}

/** The part of a fleet write that runs under the lock: with a `base`, replay this writer's change
 * onto the file as it is now, then write. Returns what it wrote. */
function replayAndWrite(
  path: string,
  projects: ProjectConfig[],
  settings: Partial<JetstreamConfig>,
  now: Date,
  base?: FleetSnapshot,
): FleetSnapshot {
  if (base) {
    const disk = readConfigFile(path);
    if (disk.corrupt) throw new Error(`${path} became unreadable since it was read; not overwriting it`);
    ({ projects, settings } = replayFleetDelta(disk, base, { projects, settings }));
  }
  writeFleetFileNow(path, projects, settings, now);
  return { projects, settings };
}

/** Writes take milliseconds: by default wait this long for another writer, and treat a lock this old
 * as left by a writer that crashed. */
const FLEET_LOCK_WAIT_MS = 3_000;
const FLEET_LOCK_STALE_MS = 10_000;

/** Try once to create the lock file. False while another writer holds it; a lock old enough to be a
 * crashed writer's is removed first, so the next try can take it. */
function tryFleetLock(lockPath: string, token: string): boolean {
  try {
    writeFileSync(lockPath, token, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > FLEET_LOCK_STALE_MS) rmSync(lockPath, { force: true });
    } catch {
      // released meanwhile: just retry
    }
    return false;
  }
}

/** Remove the lock file, but only while it is still ours. */
function releaseFleetLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true });
  } catch {
    // already gone
  }
}

const newLockToken = (): string => `${process.pid} ${Math.random().toString(36).slice(2)}`;
const lockHeldError = (lockPath: string): Error =>
  new Error(`another Jetstream writer is holding ${lockPath}; try again`);

/** Run `fn` holding an exclusive lock file; released only while it is still ours. */
function withFleetLock<T>(lockPath: string, waitMs: number, fn: () => T): T {
  const token = newLockToken();
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  while (!tryFleetLock(lockPath, token)) {
    if (Date.now() > deadline) throw lockHeldError(lockPath);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // a short synchronous pause
  }
  try {
    return fn();
  } finally {
    releaseFleetLock(lockPath, token);
  }
}

/** withFleetLock for the plugin: the pause between tries yields to the event loop instead. */
async function withFleetLockAsync<T>(lockPath: string, waitMs: number, fn: () => T): Promise<T> {
  const token = newLockToken();
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  while (!tryFleetLock(lockPath, token)) {
    if (Date.now() > deadline) throw lockHeldError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Nothing is awaited between taking and releasing the lock, so no other plugin work runs inside it.
  try {
    return fn();
  } finally {
    releaseFleetLock(lockPath, token);
  }
}

function writeFleetFileNow(path: string, projects: ProjectConfig[], settings: Partial<JetstreamConfig>, now: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  // Keep the PREVIOUS fleet before overwriting it. This is the user's own hand-curated list of
  // repos, every writer here replaces the file wholesale, and the rename below is atomic — so
  // without this, one bad write (a chat proposal that omitted repos, a mistaken edit) destroys it
  // with no way back. Cheap insurance: the file is a few hundred bytes.
  try {
    const previous = readFileSync(path, 'utf8');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    writeFileSync(`${path}.${stamp}.bak`, previous);
    // Keep only the most recent few. The in-app fleet editor writes on every add and remove, so
    // an unbounded trail would quietly litter the config dir with hundreds of files.
    const dir = dirname(path);
    const prefix = `${basename(path)}.`;
    const old = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
      .sort()
      .slice(0, -BACKUPS_KEPT);
    for (const f of old) rmSync(join(dir, f), { force: true });
  } catch {
    // No existing file (first run), an unreadable one, or an unreadable dir — nothing to preserve
    // and nothing to prune. A backup is insurance, never a reason to fail the write.
  }
  writeFileAtomicSync(path, renderProjectsJson(projects, settings));
}

/**
 * Union a proposed fleet with the one already on disk, keyed by canonical path.
 *
 * `jetstream chat` hands the model the BOARD, not the fleet, and its instructions say to include
 * only what the user asked for — so "add /repo/new" legitimately comes back as a one-project
 * proposal. Writing that verbatim replaced a seven-repo fleet with one. Merging makes an ADD an
 * add. A proposal that repeats an existing path wins (it may rename it); removals are deliberately
 * NOT inferred from absence, because absence is the model's normal shorthand.
 */
export function mergeFleet(
  existing: ProjectConfig[],
  proposed: ProjectConfig[],
): ProjectConfig[] {
  // Every existing entry is kept, even two spellings of one repo: the writer replays a missing id
  // as a removal, and absence is never a removal here.
  const merged = [...existing];
  for (const p of proposed) {
    const prior = merged.find((q) => canonical(q.path) === canonical(p.path));
    // Same repo, re-emitted: KEEP its existing id. Ids are how the board, the roll-up and the
    // attention list address a project, so silently renumbering one on an unrelated edit would
    // detach it from its own state.
    if (prior) merged[merged.indexOf(prior)] = { ...p, id: prior.id };
    else merged.push(p);
  }

  // Re-uniquify ids ACROSS the merge. A proposal's ids are only unique within itself — the model
  // is never shown the existing fleet — so adding `/work/jetstream` next to an existing
  // `/Personal/jetstream` produced two entries with id "jetstream". parseProjectsConfig dedupes by
  // id and keeps the FIRST, so the repo the user just asked for silently vanished on the next read:
  // chat says "Wrote 2 project(s)" and the board shows one.
  const taken = new Set<string>();
  return merged.map((p) => {
    if (!taken.has(p.id)) {
      taken.add(p.id);
      return p;
    }
    return { ...p, id: slugId(p.name, taken) }; // slugId adds to `taken` itself
  });
}

// ── In-app fleet editor: the message contract between the Settings property inspector
//    and the plugin backend. The PI can't touch the filesystem (sandboxed webview), so
//    it sends these; the backend performs the file op and replies. ──────────────────

export type FleetInbound =
  | { fleet: 'list' }
  | { fleet: 'add'; path: string; name?: string }
  | { fleet: 'remove'; id: string }
  | { fleet: 'scan'; dir: string };

export type FleetOutbound =
  | { fleet: 'projects'; projects: ProjectConfig[]; note?: FleetAddResult['reason'] }
  | { fleet: 'candidates'; dir: string; candidates: string[] }
  | { fleet: 'error'; message: string };

export interface FleetDeps {
  read: () => { projects: ProjectConfig[]; settings: Partial<JetstreamConfig>; corrupt?: boolean };
  /** `base` is the snapshot the change was made against, so the writer can replay just the change. */
  write: (
    projects: ProjectConfig[],
    settings: Partial<JetstreamConfig>,
    base: FleetSnapshot,
  ) => FleetSnapshot | void | Promise<FleetSnapshot | void>;
  /** Re-seed the live board so an edit repaints Fleet/Attention without a restart. */
  seed: (projects: ProjectConfig[]) => void;
  reply: (msg: FleetOutbound) => void | Promise<void>;
  scan: (dir: string) => string[];
}

/**
 * Handle one fleet message from the property inspector. Defensive against malformed
 * payloads (wrong shape → ignored, never throws); only writes + re-seeds when the fleet
 * actually changed. Injected deps keep it unit-testable without the SDK or a real disk.
 */
export async function handleFleetMessage(payload: unknown, deps: FleetDeps): Promise<void> {
  if (typeof payload !== 'object' || payload === null) return;
  const msg = payload as Record<string, unknown>;

  // A present-but-corrupt projects.json reads as empty; writing over it would ERASE a fleet
  // we merely failed to parse. So a mutation refuses and reports, rather than clobbering.
  const CORRUPT_MSG =
    'projects.json exists but isn’t valid JSON — fix or remove it before editing the fleet here.';
  // Persist + re-seed, turning a write failure (read-only dir, full disk) into a reported
  // error instead of an unhandled rejection with no reply to the inspector.
  // Resolves with the fleet as saved (another writer's changes included), or undefined on failure.
  const save = async (
    next: ProjectConfig[],
    settings: Partial<JetstreamConfig>,
    base: FleetSnapshot,
  ): Promise<ProjectConfig[] | undefined> => {
    let saved: ProjectConfig[] = next;
    try {
      saved = (await deps.write(next, settings, base))?.projects ?? next;
    } catch (error) {
      await deps.reply({
        fleet: 'error',
        message: `Couldn't save projects.json: ${errorMessage(error)}`,
      });
      return undefined;
    }
    deps.seed(saved); // the saved fleet, so a repo another writer added meanwhile stays on the board
    return saved;
  };

  switch (msg.fleet) {
    case 'list': {
      await deps.reply({ fleet: 'projects', projects: deps.read().projects });
      return;
    }
    case 'add': {
      if (typeof msg.path !== 'string') return;
      const { projects, settings, corrupt } = deps.read();
      if (corrupt) {
        await deps.reply({ fleet: 'error', message: CORRUPT_MSG });
        return;
      }
      const result = addToFleet(projects, {
        path: msg.path,
        name: typeof msg.name === 'string' ? msg.name : undefined,
      });
      let shown = result.projects;
      if (result.added) {
        const saved = await save(result.projects, settings, { projects, settings });
        if (!saved) return;
        shown = saved;
      }
      await deps.reply({ fleet: 'projects', projects: shown, note: result.reason });
      return;
    }
    case 'remove': {
      if (typeof msg.id !== 'string') return;
      const { projects, settings, corrupt } = deps.read();
      if (corrupt) {
        await deps.reply({ fleet: 'error', message: CORRUPT_MSG });
        return;
      }
      const next = removeFromFleet(projects, msg.id);
      let shown = next;
      if (next.length !== projects.length) {
        const saved = await save(next, settings, { projects, settings });
        if (!saved) return;
        shown = saved;
      }
      await deps.reply({ fleet: 'projects', projects: shown });
      return;
    }
    case 'scan': {
      if (typeof msg.dir !== 'string') return;
      await deps.reply({ fleet: 'candidates', dir: msg.dir, candidates: deps.scan(msg.dir) });
      return;
    }
    default:
      return;
  }
}
