import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Hook events the plugin could not receive (Stream Deck was restarting, e.g. during a chat
 * structural edit). status-hook.js appends them here; the plugin replays them once it is listening
 * again, so a turn that ended while it was down does not stay "working" on the board.
 */
export function spoolPath(home = homedir()): string {
  return join(home, '.jetstream', 'hook-spool.jsonl');
}

/** Past this size the spool starts over rather than refuse the newest event: the plugin has been
 * away long enough that most of what it holds is history. */
const MAX_SPOOL_BYTES = 256 * 1024;
/** Events older than this are history by the time they would be replayed. */
const MAX_EVENT_AGE_MS = 60 * 60_000;

/** The payload fields the plugin reads (parseHookPayload, handleHookPayload, the replay filter).
 * Nothing else is posted to /hook or spooled, so prompt text and tool input never leave the hook. */
const SPOOLED_FIELDS = [
  'hook_event_name',
  'session_id',
  'cwd',
  'notification_type',
  'source',
  'tool_name',
  'agent_id',
  '_pid',
  '_at',
] as const;

/** What the hook sends of one payload, as the live /hook body and as the spooled line alike:
 * only the fields the plugin reads. */
export function spoolProjection(payload: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const field of SPOOLED_FIELDS) {
    if (payload[field] !== undefined) kept[field] = payload[field];
  }
  // Only the list's length is read, never the task descriptions in it.
  if (Array.isArray(payload.background_tasks)) kept.background_tasks = payload.background_tasks.map(() => 0);
  return kept;
}

/** Whether the spool should start over before `bytes` more are added: it would pass its cap, or its
 * last append is older than any event takeSpool still replays. */
function shouldStartOver(path: string, bytes: number, now: number): boolean {
  try {
    const { size, mtimeMs } = statSync(path);
    return size + bytes > MAX_SPOOL_BYTES || now - mtimeMs > MAX_EVENT_AGE_MS;
  } catch {
    return false; // no spool yet
  }
}

/** Append one undelivered payload. Never throws: a hook must not fail a Claude session. */
export function appendSpool(body: string, path = spoolPath(), now = Date.now()): void {
  const line = `${body.replace(/\n/g, ' ')}\n`;
  const bytes = Buffer.byteLength(line);
  // Count the line being added, so one huge payload cannot push even a fresh spool past its cap.
  if (bytes > MAX_SPOOL_BYTES) return;
  try {
    if (shouldStartOver(path, bytes, now)) rmSync(path, { force: true });
    mkdirSync(dirname(path), { recursive: true });
    // One line per event; O_APPEND keeps concurrent hook processes from interleaving a short line.
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // unwritable home: drop the event silently
  }
}

/** Claim the spool (a rename, so events appended meanwhile start a new one) and return the payloads
 * recent enough to replay, in the order they FIRED (hooks append as they finish, not as they fire).
 * Never throws. */
export function takeSpool(path = spoolPath(), now = Date.now()): unknown[] {
  const claimed = `${path}.${process.pid}-${randomBytes(4).toString('hex')}`;
  let text: string;
  try {
    renameSync(path, claimed);
    text = readFileSync(claimed, 'utf8');
  } catch {
    return [];
  } finally {
    try {
      rmSync(claimed, { force: true });
    } catch {
      // a claimed copy that cannot be removed (a directory, no permission) must not fail the drain
    }
  }
  const payloads: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line) as { _at?: unknown };
      if (typeof payload._at === 'number' && now - payload._at > MAX_EVENT_AGE_MS) continue;
      payloads.push(payload);
    } catch {
      // a torn line is skipped, never fatal
    }
  }
  const firedAt = (p: unknown): number => {
    const at = (p as { _at?: unknown })._at;
    return typeof at === 'number' ? at : 0;
  };
  return payloads.sort((a, b) => firedAt(a) - firedAt(b));
}
