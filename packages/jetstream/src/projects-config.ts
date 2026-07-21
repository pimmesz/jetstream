import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { JetstreamConfig } from './config';

/**
 * The optional config file the plugin reads at startup to seed its board and settings —
 * an "edit a config, run a command" flow. Stream Deck owns the physical layout,
 * so this NEVER places keys or writes a key's Property Inspector: it seeds the plugin's own
 * registry (fleet / attention / project matching), and presets the plugin settings.
 */

/** Where the plugin looks for `projects.json`: `$XDG_CONFIG_HOME/jetstream/projects.json`,
 * else `~/.config/jetstream/projects.json` (on Windows, `%APPDATA%\jetstream\projects.json`).
 * `env`/`home` are injectable so the resolver is testable without touching the real env. */
export function projectsConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, 'jetstream', 'projects.json');
  const appData = env.APPDATA?.trim();
  if (appData && process.platform === 'win32') return join(appData, 'jetstream', 'projects.json');
  return join(home, '.config', 'jetstream', 'projects.json');
}

/**
 * Every path the fleet file could be at, most-specific first.
 *
 * The plugin runs under the Stream Deck app (launchd/GUI env) while `jetstream chat` and the CLI
 * run from the user's shell — they do NOT share an environment. `XDG_CONFIG_HOME` set in a shell
 * profile but absent from the GUI env is an ordinary setup, and it made the CLI write one file
 * while the plugin read another: chat reported writing the fleet successfully, and the board never
 * showed it, not even after a restart, with nothing anywhere saying why.
 */
export function projectsConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const primary = projectsConfigPath(env, home);
  const fallback = join(home, '.config', 'jetstream', 'projects.json');
  return primary === fallback ? [primary] : [primary, fallback];
}

/**
 * The fleet file to USE: the first candidate that exists, else the primary path.
 *
 * Readers AND writers must both go through this, or the split simply moves — read the fallback,
 * write the primary, and the user's edit vanishes into a file nothing loads. Resolving once means
 * whichever file already exists stays the file everyone touches.
 */
export function resolveProjectsConfigPath(
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const candidates = projectsConfigPaths(env, home);
  const found = candidates.find(exists);
  if (found) return found;
  // NOTHING exists yet, so this call decides where the file is CREATED — and the two sides must
  // agree or the fleet is written where the board will never look. `XDG_CONFIG_HOME` is typically
  // set in a shell profile only, so the CLI would create it there while the launchd-launched plugin
  // resolves `~/.config` and finds nothing, forever. Create at the environment-independent path so
  // both processes converge. (An XDG file that ALREADY exists still wins, above — this only picks
  // where a brand-new one goes.) `%APPDATA%` is genuinely present for GUI processes on Windows, so
  // it stays the primary there.
  const xdgOnly = env.XDG_CONFIG_HOME?.trim() && process.platform !== 'win32';
  return xdgOnly ? candidates[candidates.length - 1]! : candidates[0]!;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Parse the `projects` array out of a `projects.json` string into validated
 * `ProjectConfig[]`. Deliberately tolerant: bad JSON, a missing/wrong-typed `projects`
 * array, or malformed entries yield `[]` — this NEVER throws, so a broken config degrades
 * to "no seeded projects" rather than crashing the plugin at startup. Entries missing
 * id/name/path are dropped; duplicate ids keep the first.
 */
export function parseProjectsConfig(raw: string): ProjectConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const projects = (parsed as { projects?: unknown } | null | undefined)?.projects;
  if (!Array.isArray(projects)) return [];
  const seen = new Set<string>();
  const out: ProjectConfig[] = [];
  for (const entry of projects) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.id) || !isNonEmptyString(e.name) || !isNonEmptyString(e.path)) continue;
    const id = e.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: e.name, path: e.path });
  }
  return out;
}

/**
 * Parse the optional `settings` block out of a `projects.json` string into a partial config
 * preset. Tolerant — bad JSON or a missing/oddly-typed block yields `{}`. Values are
 * validated for TYPE only here; range clamping happens where the preset is merged
 * (`config.setBase` → `mergeConfig`).
 */
export function parseSettingsPreset(raw: string): Partial<JetstreamConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const settings = (parsed as { settings?: unknown } | null | undefined)?.settings;
  if (typeof settings !== 'object' || settings === null) return {};
  const s = settings as Record<string, unknown>;
  const out: Partial<JetstreamConfig> = {};
  if (s.theme === 'default' || s.theme === 'highContrast') out.theme = s.theme;
  if (typeof s.longPressMs === 'number') out.longPressMs = s.longPressMs;
  if (typeof s.usageRefreshSec === 'number') out.usageRefreshSec = s.usageRefreshSec;
  if (typeof s.escalateAfterSec === 'number') out.escalateAfterSec = s.escalateAfterSec;
  return out;
}

export interface ConfigFile {
  projects: ProjectConfig[];
  settings: Partial<JetstreamConfig>;
  /** True when the file EXISTS but couldn't be read or parsed as JSON. Startup still
   * degrades to an empty fleet, but an in-app MUTATION (add/remove) must REFUSE to write
   * when this is set — else it would overwrite a populated fleet it merely failed to read.
   * Absent on the happy path AND when the file is simply missing (a first add legitimately
   * starts from empty). */
  corrupt?: boolean;
}

/** Read `projects.json` once at startup (sync — a small read before the plugin connects).
 * A missing file yields empty projects + empty preset. A present-but-unreadable/unparseable
 * file also yields empty, but flagged `corrupt` so callers that WRITE won't clobber it.
 * Never throws. `path` is injectable for tests. */
export function readConfigFile(path = resolveProjectsConfigPath()): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [], settings: {} };
    return { projects: [], settings: {}, corrupt: true }; // present but unreadable — don't clobber
  }
  try {
    JSON.parse(raw);
  } catch {
    return { projects: [], settings: {}, corrupt: true }; // present but not JSON — don't clobber
  }
  return { projects: parseProjectsConfig(raw), settings: parseSettingsPreset(raw) };
}

/** The starter file `jetstream setup` writes when no `projects.json` exists yet. */
export const PROJECTS_TEMPLATE = `{
  "projects": [
    { "id": "example", "name": "Example", "path": "/absolute/path/to/your/repo" }
  ]
}
`;
