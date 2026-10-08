import { parseHookPayload } from '@pimmesz/jetstream-status';

/**
 * The plugin's start-up and event plumbing, kept out of plugin.ts (which boots the Stream Deck SDK
 * and cannot be imported in a test) so each rule here has a test. Clock, timers and side effects are
 * injected.
 */

/** A token getter that retries a failed mint at most once per `retryMs`, so a transient failure (a
 * full disk at login, a home not yet mounted) heals on its own instead of lasting until a restart. */
export function createTokenSource(
  ensure: () => string,
  deps: { now?: () => number; retryMs?: number; onFirstFailure?: (error: unknown) => void } = {},
): () => string | undefined {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? 60_000;
  let token: string | undefined;
  let lastAttempt: number | undefined;
  let hasReported = false;
  return () => {
    if (token) return token;
    const t = now();
    if (lastAttempt !== undefined && t - lastAttempt < retryMs) return undefined;
    lastAttempt = t;
    try {
      token = ensure();
    } catch (error) {
      if (!hasReported) {
        hasReported = true;
        deps.onFirstFailure?.(error);
      }
    }
    return token;
  };
}

/** Keep trying to bind until `maxWaitMs` has passed: an orphaned predecessor can hold the port for
 * up to ~90 s (a held /permission request). Resolves true once bound, false after giving up. */
export async function bindWithRetry(
  start: () => Promise<unknown>,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; retryMs?: number; maxWaitMs?: number } = {},
): Promise<{ bound: true } | { bound: false; error: unknown }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.maxWaitMs ?? 90_000);
  for (;;) {
    try {
      await start();
      return { bound: true };
    } catch (error) {
      if (now() >= deadline) return { bound: false, error };
      await sleep(deps.retryMs ?? 1_000);
    }
  }
}

/** Run `fn` once, `ms` after the first of a burst of calls: a hook flurry repaints once, not N times. */
export function coalesce(fn: () => void, ms: number, timer: typeof setTimeout = setTimeout): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (pending) return; // the pending pass will see the latest state
    pending = timer(() => {
      pending = undefined;
      fn();
    }, ms);
    (pending as { unref?: () => void }).unref?.();
  };
}

export interface HookPayloadDeps {
  now: () => number;
  notePid: (sessionId: string, pid: number, cwd: string) => void;
  forgetSession: (sessionId: string) => void;
  dispatch: (event: NonNullable<ReturnType<typeof parseHookPayload>>) => void;
}

/** One `/hook` POST: parse it, remember the session's process, drop an ended session's Always-Allow
 * rules (and its held prompts), then hand the event to the board. */
export function handleHookPayload(raw: unknown, deps: HookPayloadDeps): void {
  const event = parseHookPayload(raw, deps.now());
  if (!event) return;
  const pid = (raw as { _pid?: unknown } | null)?._pid;
  if (typeof pid === 'number') deps.notePid(event.sessionId, pid, event.cwd);
  if (event.event === 'SessionEnd') deps.forgetSession(event.sessionId);
  deps.dispatch(event);
}

export interface SpoolReplayDeps extends HookPayloadDeps {
  /** Fire time of the newest event the board applied for a session, if any. */
  firedAt: (sessionId: string) => number | undefined;
  onError: (error: unknown) => void;
}

/** Replay hook events spooled while no plugin was listening (takeSpool: fire order, at most an hour old). */
export function replaySpool(payloads: unknown[], deps: SpoolReplayDeps): void {
  for (const raw of payloads) {
    const fields = (raw ?? {}) as { session_id?: unknown; _at?: unknown; hook_event_name?: unknown };
    const { session_id: id, _at: at, hook_event_name: name } = fields;
    // The board may already hold a NEWER event for this session (it resumed while this one waited in the
    // spool); replaying the older one, a SessionEnd above all, would undo it.
    // Subagent events are exempt: they pair by agent id, so their order against the parent's does not matter.
    const isSubagent = name === 'SubagentStart' || name === 'SubagentStop';
    const newest = typeof id === 'string' ? deps.firedAt(id) : undefined;
    if (!isSubagent && newest !== undefined && typeof at === 'number' && at < newest) continue;
    // Apply it as of when it fired, so elapsed times, the stall glyph and doorbell order are not reset.
    const now = deps.now();
    const firedAt = typeof at === 'number' ? Math.min(at, now) : now;
    try {
      handleHookPayload(raw, { ...deps, now: () => firedAt });
    } catch (error) {
      deps.onError(error); // one bad payload must not lose the rest: takeSpool already removed them
    }
  }
}

/** Live /hook payloads held while the board restores. Bounded in count and size: /hook is untokened, and
 * one body may be up to 256 KB, so a flood must not grow it. */
const MAX_HELD_HOOKS = 1024;
const MAX_HELD_BYTES = 8 * 1024 * 1024;

/** Holds live /hook payloads until `open()`, which plugin.ts calls right after the spool replay, so an
 * older spooled event never lands on top of a newer live one. Each held payload keeps its arrival time. */
export function createHookGate(
  apply: (raw: unknown, at: number) => void,
  deps: { now?: () => number; onError?: (error: unknown) => void } = {},
): { accept: (raw: unknown) => void; open: () => void } {
  const now = deps.now ?? Date.now;
  let held: Array<{ raw: unknown; at: number }> | undefined = [];
  let heldBytes = 0;
  return {
    accept: (raw) => {
      if (!held) return apply(raw, now());
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(raw) ?? '');
      } catch {
        return; // nested too deep to measure: no real hook sends that, so drop it like an oversize body
      }
      if (held.length >= MAX_HELD_HOOKS || heldBytes + bytes > MAX_HELD_BYTES) return;
      heldBytes += bytes;
      held.push({ raw, at: now() });
    },
    open: () => {
      const queue = held ?? [];
      held = undefined;
      for (const { raw, at } of queue) {
        try {
          apply(raw, at);
        } catch (error) {
          deps.onError?.(error); // one bad payload must not lose the rest
        }
      }
    },
  };
}

/** Write the debounced board checkpoint on every way out. Stream Deck often stops the plugin by closing
 * its socket, and the process then exits on its own with no signal; 'exit' still fires (synchronous code
 * only, which `flush` is). A signal listener replaces Node's default exit, so those exit explicitly. */
export function flushOnExit(
  flush: () => void,
  proc: { once: (event: string, listener: () => void) => unknown; exit: (code: number) => void } = process,
): void {
  proc.once('exit', flush);
  for (const signal of ['SIGTERM', 'SIGINT']) proc.once(signal, () => proc.exit(0));
}
