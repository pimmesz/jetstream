import { execFile } from 'node:child_process';

/**
 * The platform's real "open this file with its default app" launcher, or undefined where
 * none exists. argv arrays only, never a shell, so the path can't be re-parsed as a command.
 * Shared by the init wizard and the in-app "Build my layout" so both hand a freshly written
 * `.streamDeckProfile` to the Stream Deck app (which registers that file type) identically.
 */
export function defaultOpenFile(): ((path: string) => void) | undefined {
  if (process.platform === 'darwin') return (path) => execFile('open', [path], () => {});
  if (process.platform === 'win32') return (path) => execFile('explorer', [path], () => {});
  return undefined;
}
