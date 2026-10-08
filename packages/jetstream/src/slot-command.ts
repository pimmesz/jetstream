import { open, realpath, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { normalizeColor } from './slot-color';
import type { SlotKind, SlotSettings } from './actions/slot';

/** A validated `POST /slot` command: where to put the key and its full replacement settings. */
export interface SlotCommand {
  coord: string;
  column: number;
  row: number;
  settings: SlotSettings;
}

const KINDS: readonly SlotKind[] = [
  'empty', 'app', 'url', 'run', 'build', 'stopall', 'fleet', 'project', 'volup', 'voldown', 'volmute',
  'chat', 'logo', 'usage', 'attention',
];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Only http(s) URLs may be opened — blocks `file:`, `javascript:`, custom schemes. */
export function isHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Targets the OS opener would EXECUTE rather than show: scripts and shortcuts. An `app` slot pointing
 * at one is a run key in disguise, so it is gated by `allowRunKeys` like a `run` key. Pure. */
const SCRIPT_EXT = /\.(command|sh|bash|zsh|tool|terminal|workflow|scpt|applescript|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|lnk)$/i;
export function isScriptTarget(app: string | undefined): boolean {
  if (typeof app !== 'string') return false;
  const target = app.trim();
  // A URL (file://, or any scheme) is resolved by the opener in ways a suffix check cannot see:
  // percent-encoding, a query or a fragment. Gate it like a script. `C:\` is a drive, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return true;
  return SCRIPT_EXT.test(withoutTrailingSlash(target));
}

/** A trailing slash hides nothing from the opener, so suffix checks look past it. */
function withoutTrailingSlash(target: string): string {
  let end = target.length;
  while (end > 0 && (target[end - 1] === '/' || target[end - 1] === '\\')) end--;
  return target.slice(0, end);
}

/** Files macOS hands to a launcher that runs them (Python, Jar Launcher) or follows to another
 * target that may be a script (Finder location files). */
const LAUNCHER_EXT = /\.(py|jar|fileloc|inetloc|webloc)$/i;

const hasRunName = (target: string): boolean =>
  isScriptTarget(target) || LAUNCHER_EXT.test(withoutTrailingSlash(target.trim()));

/**
 * Whether opening a target (an `app` slot, or a project path) would run something, decided on disk at
 * press time: a run-like name (also after following symlinks), a regular file with any execute bit, which
 * the opener runs in Terminal whatever its name, or a Finder alias. A folder just opens, even one named
 * like a script (`three.js`), except an Automator `.workflow`, which the opener runs. A target that is
 * not on disk is judged by its name alone.
 */
export async function isRunTarget(app: string | undefined): Promise<boolean> {
  if (typeof app !== 'string') return false;
  try {
    // Decide on the resolved path: a symlink, `x.workflow/.` or `x.workflow/Contents/..` is the workflow too.
    const real = await realpath(app.trim());
    const info = await stat(real);
    if (info.isDirectory()) return /\.workflow$/i.test(real);
    if (hasRunName(app) || hasRunName(real)) return true;
    if (!info.isFile()) return false;
    return (info.mode & 0o111) !== 0 || (await isFinderAlias(real));
  } catch {
    return hasRunName(app); // missing or unreachable: only its name can tell
  }
}

/** A Finder alias is bookmark data ("book" at byte 0, "mark" at byte 8) that the opener follows to its
 * target. Node cannot resolve it, so an alias is gated whatever it points at. */
async function isFinderAlias(path: string): Promise<boolean> {
  const head = Buffer.alloc(12);
  const file = await open(path, 'r');
  try {
    await file.read(head, 0, 12, 0);
  } finally {
    await file.close();
  }
  return head.toString('latin1', 0, 4) === 'book' && head.toString('latin1', 8, 12) === 'mark';
}

/** A safe launch target for the 'app' slot, so a key planted via the unauthenticated /slot endpoint
 * can't inject a flag into the OS opener: a leading '-' would be parsed as an option by open/xdg-open,
 * so reject it. Pure — mirrors isHttpUrl, and guards at parse AND exec time.
 * NOTE: this deliberately does NOT restrict WHICH path is opened — the slot legitimately opens apps,
 * files and folders (native `system.open` keys migrate through here, see board-layout toSlotKey).
 * Blocking a *malicious* app bundle needs a location/existence whitelist, a separate follow-up
 * (security audit authz-2). Run-like targets are gated separately at press time (isRunTarget). */
export function isSafeAppTarget(app: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!app || app.startsWith('-')) return false; // a '-' target is parsed as an option by open/xdg-open
  if (platform === 'win32' && app.startsWith('/')) return false; // '/select', '/root', … are explorer switches
  return true;
}

/** The chessboard-style label for a key at (column,row), both 0-indexed: row = letter (a = top),
 * column = number (1 = left). So the top-right key of an XL (col 7, row 0) is "a8". Pure. Lives
 * here, not in the SDK action module, so the CLI can use it without loading the Stream Deck SDK. */
export function coordLabel(column: number, row: number): string {
  return `${String.fromCharCode(97 + row)}${column + 1}`;
}

/** "a8" → {column:7,row:0}; row = letter (a = top), column = 1-indexed number. Deliberately NOT
 * bound-checked against a deck — the IPC matches whatever key instances are actually visible, not a
 * fixed grid. Null when unparseable. Inverse of `coordLabel`. */
export function coordToCell(label: string): { column: number; row: number } | null {
  const m = /^\s*([a-z])\s*(\d+)\s*$/i.exec(label);
  if (!m) return null;
  const row = m[1]!.toLowerCase().charCodeAt(0) - 97; // 'a' → 0
  const column = Number(m[2]) - 1; // 1-indexed → 0-indexed
  if (row < 0 || column < 0) return null;
  return { column, row };
}

/**
 * Validate an untrusted `POST /slot` body into a SlotCommand, or null (→ 400). Whitelists `kind`,
 * requires the per-kind target, http-only for URLs, and only a `string[]` for run args — mirroring
 * the layout designer's "the caller can't smuggle a malformed key" stance. The resulting settings
 * are a FULL replacement (setSettings overwrites), so a retarget never leaves stale fields behind.
 */
export function parseSlotCommand(raw: unknown): SlotCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const coord = str(r.coord);
  if (!coord) return null;
  const cell = coordToCell(coord);
  if (!cell) return null;
  const kind = KINDS.includes(r.kind as SlotKind) ? (r.kind as SlotKind) : undefined;
  if (!kind) return null;
  const label = str(r.label);
  const icon = str(r.icon); // custom key image (data: URI or image path); app slots self-icon without it
  const sub = str(r.sub);
  const glyph = str(r.glyph);
  const colorRaw = str(r.color);
  const color = colorRaw ? normalizeColor(colorRaw) : undefined; // hex or a known name; else dropped
  const extra = {
    ...(label ? { label } : {}),
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(sub ? { sub } : {}),
    ...(glyph ? { glyph } : {}),
  };

  let settings: SlotSettings;
  switch (kind) {
    case 'app': {
      const app = str(r.app);
      if (!app || !isSafeAppTarget(app)) return null;
      settings = { kind, app, ...extra };
      break;
    }
    case 'url': {
      const url = str(r.url);
      if (!url || !isHttpUrl(url)) return null;
      settings = { kind, url, ...extra };
      break;
    }
    case 'run': {
      const command = str(r.command);
      if (!command) return null;
      // args must be a pure string[] — reject anything that could coerce oddly into an argv slot.
      if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === 'string'))) return null;
      const args = Array.isArray(r.args) ? (r.args as string[]) : undefined;
      const cwd = str(r.cwd);
      settings = { kind, command, ...(args ? { args } : {}), ...(cwd ? { cwd } : {}), ...extra };
      break;
    }
    case 'project': {
      // A live per-repo status light. `path` is required (the repo whose sessions colour the key);
      // `name` defaults to the folder name at render. Without this case the per-kind whitelist would
      // strip path/name and the key would bind to nothing.
      const path = str(r.path);
      if (!path) return null;
      settings = { kind, path, ...(str(r.name) ? { name: str(r.name) } : {}), ...extra };
      break;
    }
    case 'usage':
      // Whose usage: Claude unless Codex is named. Anything else is dropped, never passed through.
      settings = { kind, ...(r.provider === 'codex' ? { provider: 'codex' as const } : {}), ...extra };
      break;
    case 'attention':
    case 'build':
    case 'stopall':
    case 'fleet':
    case 'volup':
    case 'voldown':
    case 'volmute':
    case 'chat':
    case 'logo':
      // No per-key fields — a live/static face. `stopall`'s destructive press is gated (allowStopKeys);
      // 'chat'/'logo' open `jetstream chat` (a compile-time-constant command, so ungated); the rest
      // (build/fleet/vol*) are inert/benign. Cosmetic overrides in `extra` are safe.
      settings = { kind, ...extra };
      break;
    default: // 'empty' — clear the key back to a self-labeling slot
      settings = { kind: 'empty' };
  }
  return { coord, column: cell.column, row: cell.row, settings };
}

/** Whether a key's stored settings are the ones a caller expects: a missing kind is an empty slot. Pure. */
export function sameSlot(actual: unknown, expected: unknown): boolean {
  const norm = (v: unknown): Record<string, unknown> => {
    const o = typeof v === 'object' && v !== null ? { ...(v as Record<string, unknown>) } : {};
    if (o.kind === undefined) o.kind = 'empty';
    return o;
  };
  return isDeepStrictEqual(norm(actual), norm(expected));
}

/** The settings the plugin actually stores for a live slot edit: `/slot` keeps only each kind's own
 * fields (an empty slot drops its cosmetics), so compare and remember in that form. Pure. */
export function storedSlotSettings(settings: Record<string, unknown> | null): Record<string, unknown> {
  return parseSlotCommand({ coord: 'a1', ...(settings ?? {}) })?.settings ?? { kind: 'empty' };
}
