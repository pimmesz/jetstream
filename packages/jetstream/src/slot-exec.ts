import { spawn } from 'node:child_process';
import { augmentedPath } from './exec-path';
import { isHttpUrl, isSafeAppTarget } from './slot-command';
import type { SlotSettings } from './actions/slot';

/** What a configured slot spawns on press: argv[0] + a pre-split argument vector — NEVER a shell
 * string. */
export interface ExecPlan {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** The platform's "open this app/URL" launcher. argv arrays only, never a shell. */
const opener = (platform: NodeJS.Platform): string =>
  platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';

/**
 * Resolve a slot's settings into the argv to spawn on press — or null when the slot is empty or its
 * target is missing/unsafe (non-http URL), so a bad slot just no-ops instead of doing something
 * surprising. PURE: no spawning, so it's unit-testable (e.g. that a `;rm -rf ~` arg stays one literal
 * element and is never split). The URL guard is duplicated here (not only at parse time) so even a
 * persisted bad `url` can't launch.
 */
export function execPlan(s: SlotSettings, platform: NodeJS.Platform = process.platform): ExecPlan | null {
  switch (s.kind) {
    case 'app':
      // Guard here too (not only at parse) so even a persisted/planted bad `app` can't launch — the
      // same defence-in-depth the `url` case gets from isHttpUrl.
      return s.app && isSafeAppTarget(s.app, platform) ? { cmd: opener(platform), args: [s.app] } : null;
    case 'url':
      return s.url && isHttpUrl(s.url) ? { cmd: opener(platform), args: [s.url] } : null;
    case 'run':
      return s.command ? { cmd: s.command, args: s.args ?? [], ...(s.cwd ? { cwd: s.cwd } : {}) } : null;
    default:
      return null; // 'empty' / absent
  }
}

/**
 * Spawn an ExecPlan detached so it outlives the plugin (mirrors `openProject`). `shell` stays false
 * (the default) — so shell metacharacters in `args` are inert literal arguments, never operators.
 * PATH is augmented so a CLI opener (xdg-open) or user command resolves under the GUI's stripped
 * PATH. Returns false only on a synchronous spawn failure.
 */
export function runPlan(plan: ExecPlan): boolean {
  try {
    const child = spawn(plan.cmd, plan.args, {
      detached: true,
      stdio: 'ignore',
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      env: { ...process.env, PATH: augmentedPath() },
    });
    child.on('error', () => {
      /* the key press already gave feedback; nothing to surface post-hoc */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
