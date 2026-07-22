import { createServer, type IncomingMessage, type Server } from 'node:http';

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
  onPermission?: (raw: unknown) => Promise<string | undefined>;
  /** Live board edits (`/slot`): retarget the slot key at a coordinate and resolve with
   * `{status, body}`. Omit (old build) → the endpoint 404s so the CLI can say "update the plugin". */
  onSlot?: (raw: unknown) => Promise<{ status: number; body: string }>;
  /** Gate for the state-changing endpoints: return false to answer 401. `endpoint` says what is at
   * stake — `/hook` only colours keys, while `/permission` and `/slot` answer permission prompts and
   * plant keys — so the policy can treat them differently. `/health` stays open: it is a liveness
   * probe the installer needs before a token can exist, and it discloses only the version.
   * Omit to leave everything open (tests). */
  authorize?: (headers: IncomingMessage['headers'], endpoint: 'status' | 'sensitive') => boolean;
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
    const server = createServer((req, res) => {
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
      if (handlers.authorize && !handlers.authorize(req.headers, endpoint)) {
        req.resume();
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/hook') {
        readBody(req, (body) => {
          if (body !== undefined) {
            try {
              handlers.onPayload(JSON.parse(body));
            } catch {
              /* not JSON — drop */
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
          let raw: unknown;
          try {
            raw = JSON.parse(body);
          } catch {
            defer();
            return;
          }
          // Hold the response open until the deck answers (or the plugin times out).
          handlers
            .onPermission(raw)
            .then((decision) => {
              if (decision === undefined) {
                defer();
              } else {
                res.writeHead(200, { 'content-type': 'application/json' });
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
            .catch(() => {
              res.writeHead(500);
              res.end();
            });
        });
        return;
      }
      res.writeHead(404);
      res.end();
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
