import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write';
import { errorMessage } from './errors';

/**
 * The Stream Deck app starts the plugin without your shell profile, so a CLAUDE_CONFIG_DIR or
 * CODEX_HOME exported there never reaches it. The CLI records them in this file and the plugin
 * adopts them as it starts. No env var moves this path, so both sides always agree on it.
 */
export function shellDirsPath(home = homedir()): string {
  return join(home, '.jetstream', 'shell-dirs.json');
}

const KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
const MAX_RECORD_BYTES = 4096;

/** Only an absolute path means the same outside a shell; control characters never belong in one. */
function isUsableDir(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  return isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * The file's text, only when it is a small regular file this user owns that nobody else can write:
 * the plugin writes its hooks wherever the record points. Undefined otherwise. Windows has no uid,
 * so there the profile folder's permissions do this job.
 */
export function readOwned(path: string, uid = process.getuid?.()): string | undefined {
  let fd: number;
  try {
    // O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a FIFO from hanging the open.
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    fd = openSync(path, flags);
  } catch {
    return undefined; // no record yet, a symlink or unreadable: the plugin keeps its own env
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
    if (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) return undefined;
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * CLI side: make the record mirror this shell's dirs, so the plugin uses them from its next start.
 * Never throws: returns a one-line note for the caller to print when the record changed or could
 * not be written, and undefined when nothing changed.
 */
export function recordShellDirs(
  env: NodeJS.ProcessEnv = process.env,
  path = shellDirsPath(),
  uid = process.getuid?.(),
): string | undefined {
  // sudo keeps HOME on macOS but drops the user's env, so a root run never speaks for their shell.
  if (uid === 0) return undefined;
  const dirs: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const key of KEYS) {
    const value = env[key]?.trim();
    if (isUsableDir(value)) dirs[key] = value;
  }
  const current = readOwned(path, uid);
  try {
    if (Object.keys(dirs).length === 0) {
      rmSync(path, { force: true });
      if (current === undefined) return undefined;
      return (
        'This shell sets neither CLAUDE_CONFIG_DIR nor CODEX_HOME now, so the Stream Deck plugin ' +
        'goes back to ~/.claude and ~/.codex from its next start.'
      );
    }
    const json = `${JSON.stringify(dirs, null, 2)}\n`;
    if (json === current) return undefined;
    writeFileAtomicSync(path, json, { mode: 0o600 });
    const shown = Object.entries(dirs).map(([key, dir]) => `${key}=${dir}`);
    return `Recorded for the Stream Deck plugin, which uses ${shown.join(' and ')} from its next start.`;
  } catch (error) {
    return (
      `Could not update ${path} (${errorMessage(error)}), so the Stream Deck plugin does not ` +
      "follow this shell's CLAUDE_CONFIG_DIR and CODEX_HOME. Fix that folder's permissions and " +
      'run this command again.'
    );
  }
}

/**
 * Plugin side: for each dir the plugin's own env leaves empty, use the recorded one. The plugin's
 * env (for example `launchctl setenv`) always wins. A missing, untrusted or damaged record changes
 * nothing.
 */
export function adoptShellDirs(
  env: NodeJS.ProcessEnv = process.env,
  path = shellDirsPath(),
): void {
  const text = readOwned(path);
  if (text === undefined) return;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return; // damaged: the next CLI run rewrites it
  }
  // Only an object holds named keys; an array or a bare value adopts nothing.
  if (typeof record !== 'object' || record === null) return;
  for (const key of KEYS) {
    const value = (record as Record<string, unknown>)[key];
    if (!env[key]?.trim() && isUsableDir(value)) env[key] = value;
  }
}
