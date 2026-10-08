import { request } from 'node:http';
import { MAC_HEADER, NONCE_HEADER, newNonce, permissionMac } from '@pimmesz/jetstream-status';
import { resolvedPort } from './server';
import { readToken } from './listener-token';

/** The loopback port the plugin's hook listener binds — the shared `resolvedPort()` so the CLI,
 * the plugin bind, and doctor's report can never drift. */
const port = resolvedPort;

/** Is the Jetstream plugin's hook listener up? A GET /health preflight so a live edit fails fast
 * with an actionable message instead of hanging on a dead port. */
export function pluginAlive(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: port(), path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** POST a slot command to the running plugin; resolves the HTTP status (200 = applied, 404 = no slot
 * at that coordinate on the active profile, 400 = rejected, 401 = token missing or stale), or -1 on
 * a connection failure. Read the token per call: the plugin writes it on first run, so a CLI that
 * cached it at import time would miss the very first one.
 * Signed like the permission hook: a nonce and an HMAC over the exact body, never the token itself,
 * since whatever answers the /health probe could be another user squatting the port. */
export function sendSlot(body: Record<string, unknown>, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    const text = JSON.stringify(body);
    const payload = Buffer.from(text, 'utf8');
    const token = readToken();
    const nonce = newNonce();
    const req = request(
      {
        host: '127.0.0.1',
        port: port(),
        path: '/slot',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...(token ? { [NONCE_HEADER]: nonce, [MAC_HEADER]: permissionMac(token, 'slot', nonce, text) } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? -1);
      },
    );
    req.on('error', () => resolve(-1));
    req.on('timeout', () => {
      req.destroy();
      resolve(-1);
    });
    req.end(payload);
  });
}
