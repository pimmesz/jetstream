import streamDeck from '@elgato/streamdeck';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { augmentedPath } from './exec-path';
import { isClaudeCommand } from './discover';

export interface Command {
  cmd: string;
  args: string[];
}

/** macOS editor apps to prefer, in order — opened via `open -a`, which is PATH-independent
 * (so it works under the Stream Deck GUI's stripped launchd PATH). */
const MAC_EDITOR_APPS = ['Visual Studio Code', 'Cursor'];
/** CLI editors to prefer on Linux/Windows, in order. */
const CLI_EDITORS = ['code', 'cursor'];

/** A macOS app bundle present in either standard Applications location. */
function macAppExists(app: string): boolean {
  return (
    existsSync(`/Applications/${app}.app`) ||
    existsSync(join(homedir(), 'Applications', `${app}.app`))
  );
}

/** Is `cmd` resolvable on the augmented PATH? Mirrors the GUI-PATH fix so an editor CLI is
 * found even when the plugin runs under Stream Deck's stripped launchd PATH. */
function cliOnPath(cmd: string): boolean {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, cmd + ext))) return true;
  }
  return false;
}

export interface OpenDeps {
  /** Does a macOS app bundle exist? Injectable for tests. */
  appExists?: (app: string) => boolean;
  /** Is a CLI resolvable on the augmented PATH? Injectable for tests. */
  onPath?: (cmd: string) => boolean;
  /** $EDITOR override; defaults to process.env.EDITOR. */
  editor?: string;
}

/**
 * The "open this project" command: reveal the project FOLDER in an auto-detected editor
 * (VS Code → Cursor → $EDITOR), falling back to the OS folder opener. No shell, no terminal,
 * and it never launches `claude` — pressing a project key just opens the project. argv arrays
 * only, so the path is never re-parsed as a command. Always returns a command (the OS opener
 * is the floor), so the key always does *something*.
 */
export function buildOpenCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  deps: OpenDeps = {},
): Command {
  if (platform === 'darwin') {
    const appExists = deps.appExists ?? macAppExists;
    for (const app of MAC_EDITOR_APPS) {
      if (appExists(app)) return { cmd: 'open', args: ['-a', app, path] };
    }
    return { cmd: 'open', args: [path] }; // Finder — always opens the folder
  }
  const onPath = deps.onPath ?? cliOnPath;
  for (const cmd of CLI_EDITORS) {
    if (onPath(cmd)) return { cmd, args: [path] };
  }
  const editor = (deps.editor ?? process.env.EDITOR ?? '').trim();
  if (editor) {
    // $EDITOR may carry flags ("code --wait" / "code -n"); split so the executable is just the
    // command, not the whole string (which would ENOENT).
    const [cmd, ...editorArgs] = editor.split(/\s+/);
    if (cmd) return { cmd, args: [...editorArgs, path] };
  }
  return platform === 'win32'
    ? { cmd: 'explorer', args: [path] }
    : { cmd: 'xdg-open', args: [path] };
}

/** Is `pid` a live Claude Code CLI process? Guards interrupt against PID reuse and against a
 * hook parent that turned out to be a shell wrapper — we only SIGINT something that actually IS
 * the Claude session. Uses the same strict classifier as {@link probeClaudeProcess}: a substring
 * match here would authorise SIGINT against any process whose command line merely mentions
 * claude (`vim claude-notes.md`, a checkout under a path containing "claude"), which on a kill
 * path is the wrong side of "any doubt is don't". macOS/Linux only. */
export function isClaudeProcess(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return isClaudeCommand(out);
  } catch {
    return false; // no such process, or ps unavailable → don't kill
  }
}

export type ProcessProbe = 'alive' | 'dead' | 'unknown';

/**
 * Probe a recorded session pid, distinguishing a CONCLUSIVE "gone" from an inconclusive probe
 * FAILURE — so the session reaper never erases a live session just because `ps` couldn't run
 * (EMFILE under load, a timeout). Unlike {@link isClaudeProcess} (a kill guard where any doubt is
 * "don't"), the reaper needs to tell "definitely dead" from "couldn't tell":
 * - `alive`   — `ps` ran and the pid is a live Claude process.
 * - `dead`    — `ps` ran and the pid is absent (exit 1) OR belongs to a non-Claude process (its
 *               Claude session ended; the pid may have been reused) → the session is gone.
 * - `unknown` — `ps` itself failed (ENOENT / timeout / EMFILE), so we can't tell — NEVER reap.
 * macOS/Linux only; win32 → `unknown` (never reaped).
 */
export function probeClaudeProcess(pid: number, platform: NodeJS.Platform = process.platform): ProcessProbe {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return 'unknown';
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    // Strict classifier (the executable IS claude), NOT a substring match — else a reused pid running
    // e.g. `vim claude-notes.md` would read 'alive' and keep a dead session's status pinned.
    return isClaudeCommand(out) ? 'alive' : 'dead'; // ran (exit 0): a live Claude, else the pid moved on
  } catch (err) {
    // `ps -p <absent>` exits 1 with empty output → a conclusive "no such process". Any OTHER failure
    // (ENOENT, or a 2s timeout that SIGTERMs ps → status null) is inconclusive — never call it dead.
    return (err as { status?: number | null }).status === 1 ? 'dead' : 'unknown';
  }
}

/**
 * How long a PID is left alone after being SIGINTed. The board does not repaint until the next
 * hook event or the 5s discovery poll, so a press can look like it did nothing and invite another
 * — and Claude Code escalates a second Ctrl-C within about a second from "interrupt this turn" to
 * "end the session", losing the user's context. Re-signalling a process that got one 200ms ago
 * cannot help under either behaviour, so the cooldown is right without needing to know which.
 */
const INTERRUPT_COOLDOWN_MS = 2_000;
const lastInterrupt = new Map<number, number>();

/**
 * SIGINT the given PIDs that are verified to still be Claude sessions, skipping any signalled
 * within the cooldown. Returns how many sessions are now being interrupted — freshly signalled
 * PLUS those still inside their cooldown, so a second press on a session that is already stopping
 * reports success rather than flashing "nothing to interrupt" at a user who did nothing wrong.
 * 0 means exactly that: nothing safe to interrupt.
 *
 * The cooldown lives HERE rather than in the key handlers so every caller gets it — the stop-all
 * key, the slot `stopall` kind, and both long-press interrupts.
 */
/** Seams for testing — the cooldown is unreachable otherwise, since `isClaudeProcess` is false for
 * every PID a test can safely use and a real `kill` would signal the test runner. */
export interface InterruptDeps {
  isClaude?: (pid: number, platform: NodeJS.Platform) => boolean;
  kill?: (pid: number) => void;
  now?: () => number;
}

export function interruptPids(
  pids: number[],
  platform: NodeJS.Platform = process.platform,
  deps: InterruptDeps = {},
): number {
  const isClaude = deps.isClaude ?? isClaudeProcess;
  const kill = deps.kill ?? ((pid: number): void => void process.kill(pid, 'SIGINT'));
  const now = (deps.now ?? Date.now)();
  // Drop expired entries first, so the map stays bounded by "PIDs signalled in the last 2s"
  // instead of growing with every session the fleet has ever run.
  for (const [pid, at] of lastInterrupt) {
    if (now - at >= INTERRUPT_COOLDOWN_MS) lastInterrupt.delete(pid);
  }
  let sent = 0;
  for (const pid of pids) {
    if (!isClaude(pid, platform)) continue;
    if (lastInterrupt.has(pid)) {
      sent += 1; // already interrupting — count it, but do not signal again
      continue;
    }
    try {
      kill(pid);
      lastInterrupt.set(pid, now);
      sent += 1;
    } catch {
      /* process exited between the check and the signal */
    }
  }
  return sent;
}

/** Fire the open command, detached so the editor outlives the plugin process. PATH is
 * augmented so a CLI opener (code/cursor/xdg-open) resolves under the GUI's stripped PATH.
 * Returns false only when the spawn fails synchronously. */
export function openProject(path: string, platform: NodeJS.Platform = process.platform): boolean {
  // A repo that moved or was deleted made this a completely silent dead key: `spawn` succeeds, the
  // opener fails asynchronously, and every caller alerts only on this return value — so the press
  // did nothing at all, with no blip and no message. One existence check turns that into the alert
  // the callers already implement.
  if (!existsSync(path)) return false;
  const command = buildOpenCommand(path, platform);
  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: augmentedPath() },
    });
    // The press already gave feedback, so there is nothing to show now — but log it, or an opener
    // that fails asynchronously (a missing editor, a TCC denial) leaves no trace anywhere.
    child.on('error', (error) => {
      streamDeck.logger.warn(`Jetstream could not open ${path}`, error);
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
