import { statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A deck "stop" for one Claude session, handed from the plugin to the PreToolUse stop gate as a
 * file. An external SIGINT ends the whole session (Claude Code 2.1.132+), so a stop has to come
 * from inside: the gate answers the session's next tool call with `{"continue": false}`.
 */

/** Session ids are uuids; anything else could escape the flag directory. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A flag older than this belongs to a turn that is long over, so it must not stop a new one. */
export const STOP_FLAG_TTL_MS = 10 * 60_000;

/** What the gate prints: Claude stops processing after the hook and shows the reason. */
export const STOP_OUTPUT = JSON.stringify({ continue: false, stopReason: 'Stopped from the Stream Deck.' });

/** Fixed under the home dir, not XDG or CLAUDE_CONFIG_DIR: the plugin (GUI env) and the hook
 * (shell env) must always agree on it. */
export function stopFlagDir(home = homedir()): string {
  return join(home, '.config', 'jetstream', 'stop');
}

export function stopFlagPath(sessionId: string, home = homedir()): string | undefined {
  return SESSION_ID.test(sessionId) ? join(stopFlagDir(home), sessionId) : undefined;
}

/** Events that mean the turn a stop was aimed at is over. A new prompt counts: Esc ends a turn
 * without firing Stop, so the next prompt is the first sign it is over. */
const TURN_OVER: ReadonlySet<string> = new Set(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit']);

/** Drop a leftover stop when its turn is over, so it can never cut the NEXT turn short. Runs in the
 * lifecycle hook itself, so it works while Stream Deck (and the plugin) is closed. Never throws. */
export function clearStopFlagOnTurnEnd(event: unknown, sessionId: unknown, home = homedir()): void {
  if (typeof event !== 'string' || !TURN_OVER.has(event) || typeof sessionId !== 'string') return;
  const path = stopFlagPath(sessionId, home);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // No flag pending (the usual case), or it is already gone.
  }
}

/** Consume a pending stop: true only when a fresh flag existed. The flag is removed either way,
 * and only the caller whose unlink wins gets true, so parallel tool calls stop the turn once.
 * Never throws: a hook must not be able to fail a Claude session. */
export function takeStopFlag(sessionId: string, now = Date.now(), home = homedir()): boolean {
  const path = stopFlagPath(sessionId, home);
  if (!path) return false;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    unlinkSync(path);
  } catch {
    return false;
  }
  return now - mtimeMs < STOP_FLAG_TTL_MS;
}

export interface StopGateDeps {
  readStdin: () => Promise<string>;
  /** Consume a pending stop for the session (takeStopFlag). */
  take: (sessionId: string) => boolean;
  write: (output: string) => void;
}

/** The PreToolUse stop gate (stop-gate.ts), with its I/O injected so its contract is testable: prints
 * STOP_OUTPUT when a fresh flag waits for the hook's session_id, and nothing otherwise. */
export async function runStopGate(deps: StopGateDeps): Promise<void> {
  let sessionId: unknown;
  try {
    sessionId = (JSON.parse(await deps.readStdin()) as { session_id?: unknown }).session_id;
  } catch {
    return;
  }
  if (typeof sessionId === 'string' && deps.take(sessionId)) deps.write(STOP_OUTPUT);
}
