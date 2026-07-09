import {
  existsSync,
  mkdirSync,
  readdirSync,
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

/** Depth-1 children of `dir` that look like git repo roots (a `.git` dir or file).
 * Unreadable dir → []. Sorted for a stable listing. */
export function scanForGitRepos(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(dir, name))
    .filter((child) => existsSync(join(child, '.git')))
    .sort();
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
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.jetstream-tmp-${process.pid}`;
  writeFileSync(tmp, renderProjectsJson(projects, settings));
  renameSync(tmp, path);
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
