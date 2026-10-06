import { mkdirSync, writeFileSync } from 'node:fs';
import { stopFlagDir, stopFlagPath } from '@pimmesz/jetstream-status';
import { permissions } from './permissions';

/**
 * Stop the current turn of Claude sessions from the deck WITHOUT ending them. An external SIGINT
 * ends the whole session (Claude Code 2.1.132+), so a stop is a flag the PreToolUse stop gate
 * consumes on the session's next tool call, plus an immediate deny-and-interrupt for a session that
 * is blocked on a permission the deck is holding.
 */
export interface StopDeps {
  writeFlag: (sessionId: string) => boolean;
  denyPending: (sessionId: string) => boolean;
}

const defaultDeps: StopDeps = {
  writeFlag: (sessionId) => {
    const path = stopFlagPath(sessionId);
    if (!path) return false;
    try {
      mkdirSync(stopFlagDir(), { recursive: true });
      writeFileSync(path, '', { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  },
  denyPending: (sessionId) => permissions.denyAndInterrupt(sessionId),
};

/** Ask each session to stop its turn. Returns how many sessions got a stop. */
export function stopSessions(sessionIds: string[], deps: StopDeps = defaultDeps): number {
  let stopped = 0;
  for (const id of sessionIds) {
    const denied = deps.denyPending(id);
    const flagged = deps.writeFlag(id);
    if (denied || flagged) stopped += 1;
  }
  return stopped;
}
