import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
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

function hasCommand(entries: unknown, command: string): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const hooks = asRecord(entry)?.hooks;
    return (
      Array.isArray(hooks) &&
      hooks.some((h) => asRecord(h)?.type === 'command' && asRecord(h)?.command === command)
    );
  });
}

export interface MergeResult {
  next: Record<string, unknown>;
  changed: boolean;
}

function addHook(hooks: Record<string, unknown>, event: string, command: string): boolean {
  const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  if (hasCommand(entries, command)) return false;
  entries.push({ hooks: [{ type: 'command', command }] });
  hooks[event] = entries;
  return true;
}

export interface HookCommands {
  /** The silent lifecycle hook (status board), added to HOOK_EVENTS. */
  status: string;
  /** The blocking PermissionRequest hook (deck approve/deny). Optional. */
  permission?: string;
  /** The statusline hook (usage gauges). Set only if the user has no statusline. */
  usage?: string;
}

/**
 * Merge Jetstream's hooks into a Claude Code settings object. Pure and idempotent:
 * each hook is added once unless its exact command is already present; nothing
 * existing is removed or reordered. The statusline is set ONLY when the user has
 * none (never clobber e.g. afterburner's).
 */
export function mergeHooks(settings: unknown, commands: HookCommands): MergeResult {
  const base = asRecord(settings) ?? {};
  const next: Record<string, unknown> = { ...base };
  const hooks: Record<string, unknown> = { ...(asRecord(base.hooks) ?? {}) };
  let changed = false;

  for (const event of HOOK_EVENTS) {
    if (addHook(hooks, event, commands.status)) changed = true;
  }
  if (commands.permission && addHook(hooks, 'PermissionRequest', commands.permission)) {
    changed = true;
  }
  next.hooks = hooks;

  if (commands.usage !== undefined && base.statusLine === undefined) {
    next.statusLine = { type: 'command', command: commands.usage };
    changed = true;
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
  backupPath?: string;
}

export function defaultSettingsPath(home = homedir()): string {
  return join(home, '.claude', 'settings.json');
}

/** Install the hooks into `~/.claude/settings.json`: read (or start empty), merge,
 * back up the original once (`settings.json.jetstream-bak`), write pretty JSON. */
export async function installHooks(options: InstallOptions): Promise<InstallResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    raw = undefined;
  }
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

  // Back up the ORIGINAL once — COPYFILE_EXCL means a later re-install never
  // overwrites the pristine backup with already-mutated settings (EEXIST = keep it).
  let backupPath: string | undefined;
  if (raw !== undefined) {
    const candidate = `${settingsPath}.jetstream-bak`;
    try {
      await copyFile(settingsPath, candidate, constants.COPYFILE_EXCL);
      backupPath = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') backupPath = candidate;
      // any other error: proceed — the atomic write below still protects the file.
    }
  }
  // Atomic write: a same-dir temp + rename, so a crash mid-write can't truncate
  // the user's settings.json.
  await mkdir(dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.jetstream-tmp`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmpPath, settingsPath);
  return { changed: true, settingsPath, ...(backupPath ? { backupPath } : {}) };
}
