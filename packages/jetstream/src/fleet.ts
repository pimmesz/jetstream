import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { JetstreamConfig } from './config';

/**
 * The single source of the fleet rules — how a project is added, deduped, named, and
 * how projects.json is rendered/written. Deliberately dependency-light (no readline, no
 * profile generation, no Stream Deck SDK) so BOTH the terminal wizard (`init.ts`) and the
 * in-app Settings property inspector (via `handleFleetMessage`) share one implementation
 * and can't drift.
 */

/** How many timestamped fleet backups to keep beside projects.json. */
const BACKUPS_KEPT = 5;

const stripControl = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, '');

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
  if (projects.some((p) => p.path === path)) return { projects, reason: 'duplicate' };
  const taken = new Set(projects.map((p) => p.id));
  const name = stripControl(input.name ?? '').trim() || basename(path) || 'project';
  const added: ProjectConfig = { id: slugId(name, taken), name, path };
  return { projects: [...projects, added], added };
}

/** Remove the project with `id` from the fleet. Pure. */
export function removeFromFleet(projects: ProjectConfig[], id: string): ProjectConfig[] {
  return projects.filter((p) => p.id !== id);
}

/** Write projects.json atomically (same-dir temp + rename), preserving the settings block.
 * projects.json is jetstream's own file; a crash mid-write can't truncate it. */
export function writeFleetFile(
  path: string,
  projects: ProjectConfig[],
  settings: Partial<JetstreamConfig> = {},
  now: Date = new Date(),
): void {
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
  const tmp = `${path}.jetstream-tmp-${process.pid}`;
  writeFileSync(tmp, renderProjectsJson(projects, settings));
  renameSync(tmp, path);
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
  const byPath = new Map(existing.map((p) => [p.path, p]));
  for (const p of proposed) {
    const prior = byPath.get(p.path);
    // Same repo, re-emitted: KEEP its existing id. Ids are how the board, the roll-up and the
    // attention list address a project, so silently renumbering one on an unrelated edit would
    // detach it from its own state.
    byPath.set(p.path, prior ? { ...p, id: prior.id } : p);
  }

  // Re-uniquify ids ACROSS the merge. A proposal's ids are only unique within itself — the model
  // is never shown the existing fleet — so adding `/work/jetstream` next to an existing
  // `/Personal/jetstream` produced two entries with id "jetstream". parseProjectsConfig dedupes by
  // id and keeps the FIRST, so the repo the user just asked for silently vanished on the next read:
  // chat says "Wrote 2 project(s)" and the board shows one.
  const taken = new Set<string>();
  return [...byPath.values()].map((p) => {
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
  write: (projects: ProjectConfig[], settings: Partial<JetstreamConfig>) => void;
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
  const save = async (next: ProjectConfig[], settings: Partial<JetstreamConfig>): Promise<boolean> => {
    try {
      deps.write(next, settings);
    } catch (error) {
      await deps.reply({
        fleet: 'error',
        message: `Couldn't save projects.json: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
    deps.seed(next);
    return true;
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
      if (result.added && !(await save(result.projects, settings))) return;
      await deps.reply({ fleet: 'projects', projects: result.projects, note: result.reason });
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
      if (next.length !== projects.length && !(await save(next, settings))) return;
      await deps.reply({ fleet: 'projects', projects: next });
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
