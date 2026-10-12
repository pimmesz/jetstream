import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { readCodexLive, type UsageFeed } from '@pimmesz/jetstream-usage';
import { augmentedPath } from './exec-path';

/** Codex is asked for its limits at most this often; a press on the gauge asks right away. */
export const LIVE_INTERVAL_MS = 5 * 60_000;

/** nvm's bin dirs, newest Node first: an npm-installed codex lands there, and the GUI PATH never has them. */
function nvmBins(home = homedir()): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(root, version, 'bin'));
  } catch {
    return [];
  }
}

/** The first `codex` in the plugin's PATH, the usual install dirs and nvm. A relative PATH entry is
 * skipped: it would run whatever `codex` sits in the plugin's working directory. */
export function findCodex(
  dirs: string[] = [...augmentedPath().split(delimiter), ...nvmBins()],
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue;
    const path = join(dir, name);
    if (exists(path)) return path;
  }
  return undefined;
}

/** Ask the installed codex for its limits. Undefined when codex is not found or does not answer. */
async function readInstalledCodex(): Promise<UsageFeed | undefined> {
  const command = findCodex();
  if (!command) return undefined;
  // An npm-installed codex is a node script: the dir it sits in holds the node that runs it.
  return readCodexLive({ command, env: { ...process.env, PATH: [dirname(command), augmentedPath()].join(delimiter) } });
}

/**
 * A throttled live read: at most one `codex app-server` per interval, one at a time, and the last
 * good reading kept so a failed read still leaves it to compare with the logs.
 */
export function createCodexLivePoll(read: () => Promise<UsageFeed | undefined> = readInstalledCodex, intervalMs = LIVE_INTERVAL_MS) {
  let lastAttempt = -Infinity;
  let lastFeed: UsageFeed | undefined;
  let inFlight: Promise<UsageFeed | undefined> | undefined;
  return (force = false, now = Date.now()): Promise<UsageFeed | undefined> => {
    if (inFlight) return inFlight;
    if (!force && now - lastAttempt < intervalMs) return Promise.resolve(lastFeed);
    lastAttempt = now;
    inFlight = read()
      .catch(() => undefined)
      .then((feed) => (lastFeed = feed ?? lastFeed))
      .finally(() => (inFlight = undefined));
    return inFlight;
  };
}
