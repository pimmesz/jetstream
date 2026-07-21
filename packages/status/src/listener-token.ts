import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Read-only twin of the plugin's `listener-token.ts`. This package ships as the standalone hook
 * binaries Claude Code spawns, and deliberately depends on nothing — so the path rule is repeated
 * here rather than imported. Only the PLUGIN ever creates the token; a hook that finds none simply
 * sends no header and is accepted for as long as the grace period lasts.
 *
 * Keep in sync with packages/jetstream/src/{projects-config,listener-token}.ts.
 */
export const TOKEN_HEADER = 'x-jetstream-token';

/**
 * EVERY place the token could live, most-specific first.
 *
 * A single path would not be enough: the plugin runs under the Stream Deck app (launchd/GUI env)
 * while these hooks are spawned by `claude` from your shell, so the two processes do not see the
 * same environment. `XDG_CONFIG_HOME` set in a shell profile but absent from the GUI env — a
 * completely ordinary setup — would make the writer and the reader disagree about where the token
 * is, and the hook would silently send none. That is invisible during the grace period and turns
 * into "every hook 401s, board permanently dark" the moment enforcement lands. So read the
 * candidates in order and take the first that exists.
 */
export function listenerTokenPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const paths: string[] = [];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) paths.push(join(xdg, 'jetstream', 'listener-token'));
  const appData = env.APPDATA?.trim();
  if (appData && process.platform === 'win32') {
    paths.push(join(appData, 'jetstream', 'listener-token'));
  }
  paths.push(join(home, '.config', 'jetstream', 'listener-token'));
  return paths;
}

/** The first candidate path — what the plugin would have written. */
export function listenerTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return listenerTokenPaths(env, home)[0]!;
}

/** The token, or undefined when absent/empty/unreadable everywhere. Never throws — a hook must not
 * be able to fail a Claude session over its own telemetry. */
export function readToken(paths = listenerTokenPaths()): string | undefined {
  for (const path of paths) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw !== '') return raw;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

/** The auth header to merge into a request, empty when there is no token to send. */
export function tokenHeader(paths = listenerTokenPaths()): Record<string, string> {
  const token = readToken(paths);
  return token ? { [TOKEN_HEADER]: token } : {};
}
