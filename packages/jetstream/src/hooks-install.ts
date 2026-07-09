import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** The lifecycle events the board needs. Deliberately NOT PreToolUse/PostToolUse:
 * those fire on every tool call and would spawn a node process each time; the
 * board's states are fully derivable from these five. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The identity of a hook command is its SCRIPT, not the full command string: the node
 * binary in front changes between installs (Stream Deck's bundled runtime vs whichever
 * terminal node ran `jetstream setup`), and matching on the exact string made every
 * runtime switch add a DUPLICATE hook — double processes per event, and a doubled
 * blocking PermissionRequest hook. Returns the basename of the last quoted path
 * (`"<node>" "<dir>/status-hook.js"` → `status-hook.js`; the filenames are
 * jetstream-specific), or undefined for a shape we don't recognize — those fall back
 * to exact-string comparison. */
function scriptOf(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const match = /"([^"]+)"\s*$/.exec(command);
  return match ? basename(match[1]!) : undefined;
}

/** Every jetstream hook runs a script under the plugin's own `gg.pim.jetstream.sdPlugin`
 * directory (installed, dev-linked, or CLI-invoked — all under it). Requiring that marker
 * before treating an existing hook as "the same script" stops us from hijacking an
 * UNRELATED user hook that merely runs a file with the same basename (e.g. their own
 * `status-hook.js`): that stays untouched and ours is added alongside. */
const JETSTREAM_MARKER = 'gg.pim.jetstream';

function sameScript(existing: unknown, command: string): boolean {
  if (existing === command) return true;
  if (typeof existing !== 'string' || !existing.includes(JETSTREAM_MARKER)) return false;
  const ours = scriptOf(command);
  return ours !== undefined && scriptOf(existing) === ours;
}

export interface MergeResult {
  next: Record<string, unknown>;
  changed: boolean;
}

/** Add the command to the event's entries, or UPDATE an existing entry that runs the
 * same script under a stale node/path (replace, never duplicate — see scriptOf). */
function upsertHook(hooks: Record<string, unknown>, event: string, command: string): boolean {
  const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  for (let i = 0; i < entries.length; i++) {
    const entry = asRecord(entries[i]);
    const inner = entry?.hooks;
    if (!Array.isArray(inner)) continue;
    for (let j = 0; j < inner.length; j++) {
      const h = asRecord(inner[j]);
      if (h?.type !== 'command' || !sameScript(h.command, command)) continue;
      if (h.command === command) return false; // already installed, exactly
      // Same script, different runtime/path: refresh in place (cloned, not mutated).
      const nextInner = [...inner];
      nextInner[j] = { ...h, command };
      entries[i] = { ...entry, hooks: nextInner };
      hooks[event] = entries;
      return true;
    }
  }
  entries.push({ hooks: [{ type: 'command', command }] });
  hooks[event] = entries;
  return true;
}

/** The higher-overhead tool-detail events (a hook process per tool call), wired only
 * with the opt-in `--tool-detail` flag. */
export const TOOL_DETAIL_EVENTS = ['PreToolUse', 'PostToolUse'] as const;

export interface HookCommands {
  /** The silent lifecycle hook (status board), added to HOOK_EVENTS. */
  status: string;
  /** The blocking PermissionRequest hook (deck approve/deny). Optional. */
  permission?: string;
  /** The statusline hook (usage gauges). Set only if the user has no statusline. */
  usage?: string;
  /** Opt-in: also wire the status hook to PreToolUse/PostToolUse so keys show the
   * active tool. Higher overhead — off unless the user asks. */
  toolDetail?: boolean;
}

/**
 * Merge Jetstream's hooks into a Claude Code settings object. Pure and idempotent:
 * a hook is added once, keyed by its SCRIPT (a same-script entry left by a different
 * node runtime or install location is refreshed in place, never duplicated); nothing
 * foreign is removed or reordered. The statusline is set only when the user has none
 * (never clobber e.g. afterburner's) — but one that already runs OUR usage hook is
 * refreshed the same way the hooks are.
 */
export function mergeHooks(settings: unknown, commands: HookCommands): MergeResult {
  const base = asRecord(settings) ?? {};
  const next: Record<string, unknown> = { ...base };
  const hooks: Record<string, unknown> = { ...(asRecord(base.hooks) ?? {}) };
  let changed = false;

  for (const event of HOOK_EVENTS) {
    if (upsertHook(hooks, event, commands.status)) changed = true;
  }
  if (commands.toolDetail) {
    for (const event of TOOL_DETAIL_EVENTS) {
      if (upsertHook(hooks, event, commands.status)) changed = true;
    }
  }
  if (commands.permission && upsertHook(hooks, 'PermissionRequest', commands.permission)) {
    changed = true;
  }
  next.hooks = hooks;

  if (commands.usage !== undefined) {
    const existing = asRecord(base.statusLine);
    if (base.statusLine === undefined) {
      next.statusLine = { type: 'command', command: commands.usage };
      changed = true;
    } else if (
      existing?.type === 'command' &&
      sameScript(existing.command, commands.usage) &&
      existing.command !== commands.usage
    ) {
      // Ours, but pointing at a stale runtime/path — refresh; foreign ones stay.
      next.statusLine = { ...existing, command: commands.usage };
      changed = true;
    }
  }
  return { next, changed };
}

export interface InstallOptions {
  settingsPath?: string;
  commands: HookCommands;
}

export interface InstallResult {
  changed: boolean;
  settingsPath: string;
  /** Where the pristine backup lives (also set when an EARLIER install made it). */
  backupPath?: string;
  /** True only when THIS install created the backup — gates the "backed up to …"
   * message so a re-install doesn't claim a stale backup as fresh. */
  backupCreated?: boolean;
}

export function defaultSettingsPath(home = homedir()): string {
  return join(home, '.claude', 'settings.json');
}

/** Read the settings file; a missing file starts empty, any OTHER read failure
 * (EACCES, EISDIR, …) throws — silently replacing an unreadable-but-existing
 * settings.json would destroy config we merely couldn't see. */
async function readSettings(settingsPath: string): Promise<string | undefined> {
  try {
    return await readFile(settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `could not read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Back up the ORIGINAL once, crash-atomically: the content is written to a temp and
 * `link`ed into place — link fails EEXIST atomically, so a concurrent or earlier
 * install can never clobber the pristine backup, and a crash mid-write can't leave a
 * truncated one. Returns whether THIS call created it. */
async function backupOnce(
  settingsPath: string,
  raw: string,
): Promise<{ backupPath: string; backupCreated: boolean }> {
  const backupPath = `${settingsPath}.jetstream-bak`;
  const tmp = `${backupPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, raw, 'utf8');
    await link(tmp, backupPath);
    return { backupPath, backupCreated: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { backupPath, backupCreated: false }; // an earlier install's pristine copy
    }
    // Backup is best-effort: the atomic settings write below still protects the file.
    return { backupPath, backupCreated: false };
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Install the hooks into `~/.claude/settings.json`: read (or start empty), merge,
 * back up the original once (`settings.json.jetstream-bak`), write pretty JSON
 * atomically (unique same-dir temp + rename, so concurrent installers can't corrupt
 * the file). A concurrent writer landing between our read and rename is detected by
 * re-reading before the rename; the merge then retries over the fresh content
 * (bounded — mergeHooks is idempotent, so re-merging is free). */
export async function installHooks(options: InstallOptions): Promise<InstallResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  let backup: { backupPath: string; backupCreated: boolean } | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readSettings(settingsPath);
    let parsed: unknown = {};
    if (raw !== undefined) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `${settingsPath} is not valid JSON — fix or remove it, then re-run the install.`,
        );
      }
    }
    const { next, changed } = mergeHooks(parsed, options.commands);
    if (!changed) return { changed: false, settingsPath };

    if (raw !== undefined && backup === undefined) backup = await backupOnce(settingsPath, raw);

    await mkdir(dirname(settingsPath), { recursive: true });
    const tmpPath = `${settingsPath}.jetstream-tmp-${process.pid}-${attempt}`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      // TOCTOU check: if another writer (a `claude` session, a concurrent installer)
      // landed since our read, retry the merge over their content instead of
      // silently reverting it with ours.
      if ((await readSettings(settingsPath)) !== raw) continue;
      await rename(tmpPath, settingsPath);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
    return {
      changed: true,
      settingsPath,
      ...(backup ? { backupPath: backup.backupPath, backupCreated: backup.backupCreated } : {}),
    };
  }
  throw new Error(
    `${settingsPath} keeps changing under concurrent writes — close other installers/sessions and re-run.`,
  );
}
