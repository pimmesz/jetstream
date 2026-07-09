import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Locate + run the sibling `afterburner` CLI from the plugin. Stream Deck launches the
 * plugin with the bare launchd PATH (no npm global bin), so — exactly like the in-plugin
 * doctor — we probe the standard global-install dirs in addition to PATH. afterburner is a
 * SEPARATE install (npm), so any of these may legitimately return "not found".
 */

/** PATH augmented with the dirs a global `afterburner` typically lands in. */
export function augmentedPath(env: NodeJS.ProcessEnv = process.env): string {
  const extra = [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.npm-global', 'bin'),
  ];
  return [env.PATH, ...extra].filter(Boolean).join(delimiter);
}

/** The `afterburner` binary on the augmented PATH, or null if it isn't installed. */
export function resolveAfterburner(env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of augmentedPath(env).split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `afterburner${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Run `afterburner <args>` and resolve stdout (rejects on not-found / non-zero / timeout).
 * Args are always static, plugin-authored strings — never user input — so the win32 `.cmd`
 * shell path is injection-safe. The child inherits the augmented PATH so it, too, finds
 * co-located tools (gh, claude). */
export function runAfterburner(args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveAfterburner();
    if (!bin) {
      reject(new Error('afterburner not installed'));
      return;
    }
    // Windows npm shims are `afterburner.cmd`, which needs shell:true — but under shell mode
    // Node does NOT quote the command, so a bin path with a space (e.g. C:\Users\John Doe\…)
    // would be split by cmd.exe and fail. Quote it ourselves (a filesystem path can't contain
    // a `"`); do so ONLY under shell:true — a quoted path with shell:false is looked up literally.
    const useShell = bin.endsWith('.cmd');
    execFile(
      useShell ? `"${bin}"` : bin,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, PATH: augmentedPath() },
        shell: useShell,
        maxBuffer: 16 * 1024 * 1024, // a `run-once` cycle can emit a lot of stdout
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
