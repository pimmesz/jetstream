import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installHooks } from './hooks-install';
import { hookCommands } from './cli';
import { projectsConfigPath } from './projects-config';

/** Minimal logger surface — streamDeck.logger satisfies it; injectable in tests. */
export interface AutoWireLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface AutoWireDeps {
  /** The plugin's own bin/ dir (dirname of plugin.js) — where the bundled hook scripts sit,
   * so the installed hook commands point at real absolute paths wherever the .sdPlugin lives. */
  binDir: string;
  logger: AutoWireLogger;
  /** The first-run marker. Lives in the jetstream CONFIG dir (not the plugin dir, which is
   * replaced on every update) so "already auto-wired" survives plugin updates. Injectable. */
  markerPath?: string;
  /** Injected in tests; defaults to the real installer. */
  install?: typeof installHooks;
}

/** Where the first-run marker lives: alongside projects.json. */
export function defaultMarkerPath(): string {
  return join(dirname(projectsConfigPath()), 'auto-wired');
}

const say = (log: () => void): void => {
  try {
    log();
  } catch {
    // Logging is best-effort — a broken logger must never break the wire or the boot.
  }
};

/**
 * FIRST-launch onboarding: wire the hooks the board needs into ~/.claude/settings.json so
 * installing the plugin is enough to light it up — no terminal `jetstream setup` with a
 * hand-resolved plugin path. Scope and consent, deliberately:
 *
 * - Wires the five silent lifecycle hooks (status board) AND the blocking
 *   PermissionRequest hook (deck Approve/Deny; an unanswered prompt falls through to
 *   Claude's own dialog after its timeout). It does NOT touch the statusline (the usage
 *   hook) — that stays with the explicit CLI paths (`init`/`setup`/`hooks install`), as do
 *   the higher-overhead --tool-detail hooks.
 * - Runs ONCE: a marker in the jetstream config dir records that auto-wire has run, so a
 *   user who deliberately removes the hooks isn't fought on every launch. Re-wire any time
 *   with the CLI. (installHooks itself is also idempotent — same-script entries are
 *   refreshed, never duplicated, even across node-runtime changes.)
 * - NEVER throws: a failure (unreadable settings.json, contended writes) must not crash
 *   plugin boot; it logs a warning pointing at the manual path and retries next launch
 *   (the marker is only written after a successful wire).
 */
export async function autoWireHooks(deps: AutoWireDeps): Promise<void> {
  const install = deps.install ?? installHooks;
  const markerPath = deps.markerPath ?? defaultMarkerPath();
  try {
    if (existsSync(markerPath)) return; // ran before — the user's settings are theirs now
    const { status, permission, toolDetail } = hookCommands(deps.binDir, false);
    const result = await install({ commands: { status, permission, toolDetail } });
    if (result.changed) {
      say(() =>
        deps.logger.info(
          `Jetstream auto-wired its Claude hooks (status + permission) into ${result.settingsPath}` +
            (result.backupCreated ? ` (previous settings backed up to ${result.backupPath})` : '') +
            '. Restart any running `claude` sessions to pick them up.',
        ),
      );
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`);
  } catch (error) {
    say(() =>
      deps.logger.warn(
        'Jetstream could not auto-wire its Claude hooks — run `jetstream setup` from the plugin folder to do it manually.',
        error,
      ),
    );
  }
}
