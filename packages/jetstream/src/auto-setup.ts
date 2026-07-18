import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installHooks } from './hooks-install';
import { hookCommands } from './cli';
import { projectsConfigPath } from './projects-config';

/** Bump whenever the auto-wired hook SET or COMMAND FORMAT changes. The marker records the
 * version it last wired; a mismatch re-runs installHooks (idempotent) so existing installs pick up
 * the change on the update that introduces it — without re-wiring on every launch, and without
 * fighting a user who removed hooks WITHIN the same version. v1 was the pre-versioned timestamp
 * marker; v2 added the SubagentStart/SubagentStop hooks; v3 hardened the command quoting. */
const WIRE_VERSION = 3;

/** The hook-set version the marker last recorded. A missing/unreadable marker, or the old
 * timestamp-format marker (non-numeric), reads as 0 → older than any real version → forces a
 * one-time re-wire. */
function markerVersion(markerPath: string): number {
  try {
    const n = Number.parseInt(readFileSync(markerPath, 'utf8').trim(), 10);
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

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
 * - Wires the silent lifecycle hooks (status board, incl. SubagentStart/Stop), the blocking
 *   PermissionRequest hook (deck Approve/Deny; an unanswered prompt falls through to Claude's
 *   own dialog after its timeout), AND the statusline usage hook — the latter only when the user
 *   has NO statusline (mergeHooks never clobbers a foreign one, e.g. afterburner's), so the
 *   Usage key works on install without surprising anyone. The higher-overhead --tool-detail
 *   hooks stay opt-in (a node process per tool call) — enable them from the CLI or the
 *   settings Property Inspector.
 * - Runs once PER HOOK-SET VERSION: the marker in the jetstream config dir records the wire
 *   version, so a user who deliberately removes the hooks isn't fought on every launch — but an
 *   update that ADDS hooks (a WIRE_VERSION bump) re-wires once to deliver them. Re-wire any time
 *   with the CLI. (installHooks itself is also idempotent — same-script entries are refreshed,
 *   never duplicated, even across node-runtime changes.)
 * - NEVER throws: a failure (unreadable settings.json, contended writes) must not crash
 *   plugin boot; it logs a warning pointing at the manual path and retries next launch
 *   (the marker is only written after a successful wire).
 */
export async function autoWireHooks(deps: AutoWireDeps): Promise<void> {
  const install = deps.install ?? installHooks;
  const markerPath = deps.markerPath ?? defaultMarkerPath();
  try {
    if (markerVersion(markerPath) === WIRE_VERSION) return; // already wired for this hook set
    const { status, permission, usage, toolDetail } = hookCommands(deps.binDir, false);
    const result = await install({ commands: { status, permission, usage, toolDetail } });
    if (result.changed) {
      say(() =>
        deps.logger.info(
          `Jetstream auto-wired its Claude hooks (status + permission + usage) into ${result.settingsPath}` +
            (result.backupCreated ? ` (previous settings backed up to ${result.backupPath})` : '') +
            '. Restart any running `claude` sessions to pick them up.',
        ),
      );
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${WIRE_VERSION}\n`);
  } catch (error) {
    say(() =>
      deps.logger.warn(
        'Jetstream could not auto-wire its Claude hooks — run `jetstream setup` from the plugin folder to do it manually.',
        error,
      ),
    );
  }
}
