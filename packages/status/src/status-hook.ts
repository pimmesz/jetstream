import { request } from 'node:http';
import { spoolProjection } from './spool';

export interface StatusHookDeps {
  readStdin: () => Promise<string>;
  /** POST a body to the plugin's /hook; resolves false only when nothing was listening. */
  post: (body: string) => Promise<boolean>;
  appendSpool: (body: string) => void;
  clearStopFlag: (event: unknown, sessionId: unknown) => void;
  now: () => number;
  /** This hook's parent: the `claude` process, since hooks are spawned via argv, not a shell. */
  ppid: number;
}

/** The lifecycle hook, with every side effect injected so its contract is testable. */
export async function runStatusHook(deps: StatusHookDeps): Promise<void> {
  const body = await deps.readStdin();
  if (!body.trim()) return;
  // Only a JSON object can be projected, and the plugin reads nothing else. A body cut short may still
  // hold the prompt, so it is dropped rather than sent raw to the untokened /hook.
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const fields = payload as Record<string, unknown>;
  deps.clearStopFlag(fields.hook_event_name, fields.session_id);
  // Tag with the parent PID so the plugin can map session → process for interrupt.
  fields._pid = deps.ppid;
  fields._at = deps.now(); // fire time: hooks race to the plugin, so arrival order is not fire order
  // Only the fields the plugin reads, live and spooled alike: /hook is untokened, so whoever holds the
  // port must not get prompt text or tool input.
  const projected = JSON.stringify(spoolProjection(fields));
  // The plugin replays a refused event once it is listening again.
  if (!(await deps.post(projected))) deps.appendSpool(projected);
}

/** POST to the plugin; resolves false only when nothing was listening (the plugin is down). */
export function postHook(body: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        // No token: /hook is served without one by design, and sending it would hand it to whatever
        // process holds the port (DECISIONS.md 2026-10-06).
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        // A deadline for the whole request, not a socket timeout: that one only measures silence, so a
        // squatter dripping its answer a byte at a time would hold the hook open. The abort lands in 'error'.
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      },
    );
    // Refused = no plugin listening (Stream Deck restarting). A timeout is NOT spooled: the plugin may
    // already have the event, and a replay would deliver it twice.
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'ECONNREFUSED'));
    req.end(body);
  });
}
