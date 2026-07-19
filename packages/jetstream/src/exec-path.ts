import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * PATH augmented with the dirs a globally-installed CLI typically lands in. Stream Deck launches the
 * plugin with the bare launchd PATH (no npm global bin), so any subprocess we spawn (gh, claude, an
 * editor opener, lsof/ps) must search these standard install dirs in addition to PATH — otherwise it
 * silently ENOENTs under the GUI's stripped environment.
 */
export function augmentedPath(env: NodeJS.ProcessEnv = process.env): string {
  const extra = [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
  ];
  return [env.PATH, ...extra].filter(Boolean).join(delimiter);
}
