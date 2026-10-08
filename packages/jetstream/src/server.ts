import { createServer, type IncomingMessage, type Server } from 'node:http';
import { MAC_HEADER, NONCE_HEADER, macMatches, permissionMac } from '@pimmesz/jetstream-status';

export const DEFAULT_PORT = 41321;

/** The loopback port the hook listener binds — the JETSTREAM_PORT override or the shared default.
 * One source of truth so the plugin that binds, the CLI that probes, and doctor's report all agree. */
export const resolvedPort = (): number => Number(process.env.JETSTREAM_PORT) || DEFAULT_PORT;
const MAX_BODY_BYTES = 256 * 1024;

// esbuild bakes the npm package version in (scripts/build.mjs `define`); under vitest/tsc there is
// no define, so `typeof` guards it and falls back to 'dev'. /health reports it so the npm installer
// can confirm the version it just installed is the one now answering — not a still-running old one.
declare const __PKG_VERSION__: string;
export const PLUGIN_VERSION: string = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : 'dev';

/**
 * The local hook listener: Claude Code lifecycle hooks POST their payload to
 * `127.0.0.1:<port>/hook`, and each parsed JSON body is handed to `onPayload`.
 * Loopback only — never exposed to the network. Payloads are untrusted input:
 * size-capped, parse failures dropped, and nothing from them is ever executed.
 */
export interface HookServerHandlers {
  /** Fire-and-forget lifecycle events (`/hook`). */
  onPayload: (raw: unknown) => void;
  /** Blocking permission requests (`/permission`): resolve with the hook's stdout
   * (the decision JSON) to answer, or `undefined` to defer to Claude's own dialog.
   * Omit to disable deck approvals (the endpoint then always defers). */
  onPermission?: (raw: unknown, abort: AbortSignal) => Promise<string | undefined>;
  /** Live board edits (`/slot`): retarget the slot key at a coordinate and resolve with
   * `{status, body}`. Omit (old build) → the endpoint 404s so the CLI can say "update the plugin". */
  onSlot?: (raw: unknown) => Promise<{ status: number; body: string }>;
  /** Gate for the state-changing endpoints: return false to answer 401. `endpoint` says what is at
   * stake — `/hook` only colours keys, while `/permission` and `/slot` answer permission prompts and
   * plant keys — so the policy can treat them differently. `/health` stays open: it is a liveness
   * probe the installer needs before a token can exist, and it discloses only the version.
   * Omit to leave everything open (tests). */
  authorize?: (headers: IncomingMessage['headers'], endpoint: 'status' | 'sensitive') => boolean;
  /** The shared token, for a SIGNED `/permission` or `/slot` request: the hook or CLI sends a nonce
   * and an HMAC instead of the token, and a permission answer carries an HMAC back
   * (permission-client.ts in the status package). Omit (tests) to refuse signed requests. */
  permissionKey?: () => string | undefined;
  /** Where a handler failure is reported. A request still gets its normal answer, but the cause is
   * logged instead of vanishing. Also told when the socket cap drops a connection. Omit to drop it (tests). */
  onError?: (endpoint: string, error: unknown) => void;
}

/** How far a signed request's send time may be from this clock. The hooks and the CLI share this
 * machine's clock and a request must arrive within the 30 s body timeout, so older is a replay. */
const FRESH_MS = 2 * 60_000;
/** More signed requests than this inside one freshness window cannot come from the hooks or chat. */
const MAX_SEEN_NONCES = 1024;

/** The send time inside a nonce (`<ms>.<32 hex>`, see `newNonce` in the status package), or
 * undefined when the nonce has another shape. */
function nonceTime(nonce: string): number | undefined {
  const match = /^(\d{1,15})\.[0-9a-f]{32}$/.exec(nonce);
  return match ? Number(match[1]) : undefined;
}

/** One-time use of a signed request's nonce: false for a stale, malformed or already seen one, so a
 * captured request cannot be replayed. Call only once the MAC matched, so junk never fills it. */
export function nonceMemory(): (nonce: string) => boolean {
  const seen = new Map<string, number>();
  return (nonce) => {
    const at = nonceTime(nonce);
    const time = Date.now();
    if (at === undefined || Math.abs(time - at) > FRESH_MS) return false;
    // A nonce past its window is refused as stale anyway, so it no longer needs remembering.
    for (const [old, oldAt] of seen) if (time - oldAt > FRESH_MS) seen.delete(old);
    // Full: refuse rather than forget a nonce that could then be replayed.
    if (seen.has(nonce) || seen.size >= MAX_SEEN_NONCES) return false;
    seen.set(nonce, at);
    return true;
  };
}

function readBody(req: IncomingMessage, onDone: (body: string | undefined) => void): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = (body: string | undefined): void => {
    if (settled) return;
    settled = true;
    onDone(body);
  };
  req.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytes += buf.length; // real bytes, not UTF-16 string length
    if (bytes > MAX_BODY_BYTES) {
      req.destroy();
      finish(undefined);
      return;
    }
    chunks.push(buf);
  });
  req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
  // A client that hangs up before 'end' (aborted/close/error) must still settle,
  // so a held /permission handler never leaks its slot.
  req.on('aborted', () => finish(undefined));
  req.on('close', () => finish(undefined));
  req.on('error', () => finish(undefined));
}

export function startHookServer(port: number, handlers: HookServerHandlers): Promise<Server> {
  return new Promise((resolve, reject) => {
    const claimNonce = nonceMemory();
    // Node checks the header and body timeouts on this sweep (every 30 s by default), so a short one
    // makes them fire near their stated 10 s and 30 s instead of up to 30 s late.
    const server = createServer({ connectionsCheckingInterval: 1_000 }, (req, res) => {
      // CSRF guard. The legit callers (the hook scripts + the CLI, all node `http`) never send an
      // Origin/Referer; a browser ALWAYS attaches Origin on a cross-origin POST, and a simple
      // text/plain POST fires no CORS preflight — so a malicious webpage the user visits could
      // otherwise reach 127.0.0.1 and plant/rewrite keys. Reject anything carrying those headers.
      if (req.headers.origin !== undefined || req.headers.referer !== undefined) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(PLUGIN_VERSION); // the built-in version, so the installer can confirm the NEW build is up
        return;
      }
      // Everything below CHANGES state (board status, a permission answer, a key's target), so it
      // needs the shared token. Drain the body before answering 401 — a bare socket teardown would
      // surface to the hook as a connection error it cannot tell apart from "plugin not running".
      const endpoint = req.url === '/hook' ? 'status' : 'sensitive';
      // A signed /permission or /slot request proves the token with an HMAC over its body, checked
      // once the body is read, so it skips the header check here. A hook or CLI older than signing
      // still sends the token header, and still passes that check.
      const nonce = req.headers[NONCE_HEADER];
      const isSigned =
        (req.url === '/permission' || req.url === '/slot') && typeof nonce === 'string' && req.headers[MAC_HEADER] !== undefined;
      // Is this signed body MACed with the token, and its nonce fresh and never used before?
      const isGenuine = (key: string | undefined, kind: 'req' | 'slot', body: string): boolean => {
        if (!key || typeof nonce !== 'string') return false;
        return macMatches(permissionMac(key, kind, nonce, body), req.headers[MAC_HEADER]) && claimNonce(nonce);
      };
      if (!isSigned && handlers.authorize && !handlers.authorize(req.headers, endpoint)) {
        req.resume();
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/hook') {
        readBody(req, (body) => {
          if (body !== undefined) {
            let payload: unknown;
            try {
              payload = JSON.parse(body);
            } catch {
              payload = undefined; // not JSON: drop it
            }
            // Only the parse is expected to fail. A throw from the board itself is a bug, and it
            // used to be swallowed here as "not JSON".
            if (payload !== undefined) {
              try {
                handlers.onPayload(payload);
              } catch (error) {
                handlers.onError?.('/hook', error);
              }
            }
          }
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/permission') {
        readBody(req, (body) => {
          const defer = (): void => {
            res.writeHead(204);
            res.end();
          };
          if (body === undefined || !handlers.onPermission) {
            defer();
            return;
          }
          const key = isSigned ? handlers.permissionKey?.() : undefined;
          if (isSigned && !isGenuine(key, 'req', body)) {
            res.writeHead(401);
            res.end();
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(body);
          } catch {
            defer();
            return;
          }
          // Hold the response open until the deck answers (or the plugin times out). If the hook hangs
          // up first, abort so the prompt leaves the deck.
          const hungUp = new AbortController();
          res.on('close', () => {
            if (!res.writableFinished) hungUp.abort();
          });
          handlers
            .onPermission(raw, hungUp.signal)
            .then((decision) => {
              if (decision === undefined) {
                defer();
              } else {
                const mac = key && isSigned ? { [MAC_HEADER]: permissionMac(key, 'res', nonce, decision) } : {};
                res.writeHead(200, { 'content-type': 'application/json', ...mac });
                res.end(decision);
              }
            })
            .catch(defer);
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/slot') {
        readBody(req, (body) => {
          if (body === undefined || !handlers.onSlot) {
            res.writeHead(404);
            res.end();
            return;
          }
          if (isSigned && !isGenuine(handlers.permissionKey?.(), 'slot', body)) {
            res.writeHead(401);
            res.end();
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          handlers
            .onSlot(raw)
            .then(({ status, body: out }) => {
              res.writeHead(status, { 'content-type': 'application/json' });
              res.end(out);
            })
            .catch((error: unknown) => {
              handlers.onError?.('/slot', error);
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'the plugin failed to apply this key; see the Stream Deck plugin log' }));
            });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // Bound what an untokened local client can hold open. These limit RECEIVING a request only, so a
    // /permission answer held for the deck (up to ~90s) is unaffected. 128 sockets is far above the
    // hook traffic of many busy sessions plus the 32 held permission requests.
    server.maxConnections = 128;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    // Over the cap Node resets the new connection, and whatever it carried (a hook event, say) is lost.
    // Log the first drop, then at most one a minute, so a flood shows without one line per event.
    let isDropLogged = false;
    server.on('drop', () => {
      if (isDropLogged) return;
      isDropLogged = true;
      handlers.onError?.(
        'listener',
        `dropped a connection because ${server.maxConnections} sockets were already open; what it carried (a hook event, say) is lost`,
      );
      setTimeout(() => (isDropLogged = false), 60_000).unref();
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      // Never let this server keep a dead plugin instance alive: when Stream Deck restarts the
      // plugin, the old process must drain and EXIT so the port frees for its successor —
      // otherwise a zombie squats 41321 and every hook/live-edit talks to stale code.
      server.unref();
      resolve(server);
    });
  });
}
