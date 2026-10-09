import { request, type RequestOptions } from 'node:http';
import { CHALLENGE_HEADER, MAC_HEADER, NONCE_HEADER, challengeMac, isChallenge, macMatches, newNonce } from '@pimmesz/jetstream-status';
import { resolvedPort } from './server';
import { readToken } from './listener-token';

/** The loopback port the plugin's hook listener binds: the shared `resolvedPort()` so the CLI,
 * the plugin bind, and doctor's report can never drift. */
const port = resolvedPort;

/** Is the Jetstream plugin's hook listener up? A GET /health preflight so a live edit fails fast
 * with an actionable message instead of hanging on a dead port. */
export function pluginAlive(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      // A deadline for the whole request, not a socket timeout: that one only measures silence, so a
      // squatter sending a byte at a time would hold it open. The abort lands in 'error' below.
      { host: '127.0.0.1', port: port(), path: '/health', method: 'GET', signal: AbortSignal.timeout(timeoutMs) },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** A /slot answer is a short JSON status; anything longer is not the plugin talking. */
const MAX_ANSWER_BYTES = 64 * 1024;

interface Answer {
  status: number;
  body: string;
  mac: unknown;
}

/** One loopback request on its own connection (`agent: false`): a socket kept alive from the challenge
 * could belong to whatever answered it, not to whoever holds the port now. Undefined on a connection
 * failure, an answer over MAX_ANSWER_BYTES, or no full answer within `timeoutMs`. */
function exchange(options: RequestOptions, payload: Buffer | undefined, timeoutMs: number): Promise<Answer | undefined> {
  return new Promise((resolve) => {
    // A deadline for the whole exchange, like pluginAlive's: an answer dripped a byte at a time still ends.
    const signal = AbortSignal.timeout(timeoutMs);
    const req = request({ host: '127.0.0.1', port: port(), agent: false, signal, ...options }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_ANSWER_BYTES) {
          req.destroy();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? -1, body: text, mac: res.headers[MAC_HEADER] });
      });
      res.on('error', () => resolve(undefined)); // the connection dropped mid-answer
    });
    req.on('error', () => resolve(undefined)); // a refused connection, or the deadline's abort
    req.end(payload);
  });
}

/** POST a slot command to the running plugin; resolves the HTTP status (200 = applied, 404 = no slot
 * at that coordinate on the active profile, or on two decks of the same model, 400 = rejected,
 * 401 = token missing or stale, or a plugin older than this CLI), or -1 on a connection failure or an
 * answer the plugin did not sign. Read the token per call: the plugin writes it on first run, so a CLI
 * that cached it at import time would miss the very first one.
 * Signed like the permission hook: a challenge from the plugin, then a nonce and an HMAC over the exact
 * body, never the token itself, since whatever answers the /health probe could be another user
 * squatting the port. The plugin signs its answer back, so a squatter cannot report an edit applied. */
export async function sendSlot(body: Record<string, unknown>, timeoutMs = 2000): Promise<number> {
  const token = readToken();
  if (!token) return 401; // nothing to sign with, so the plugin would refuse it
  const issued = await exchange({ path: '/challenge', method: 'GET' }, undefined, timeoutMs);
  if (!issued) return -1;
  // Never fall back to the unchallenged 4.1.0 format: a squatter could refuse the challenge on purpose to
  // collect an edit it can replay. A plugin older than this CLI has no /challenge, and 401 says update it.
  if (issued.status !== 200 || !isChallenge(issued.body)) return 401;
  const challenge = issued.body;
  const text = JSON.stringify(body);
  const payload = Buffer.from(text, 'utf8');
  const nonce = newNonce();
  const headers = {
    'content-type': 'application/json',
    'content-length': payload.length,
    [CHALLENGE_HEADER]: challenge,
    [NONCE_HEADER]: nonce,
    [MAC_HEADER]: challengeMac(token, 'slot', challenge, nonce, text),
  };
  const answer = await exchange({ path: '/slot', method: 'POST', headers }, payload, timeoutMs);
  if (!answer) return -1;
  // A refusal changes nothing, so an unsigned 401 is believed.
  if (answer.status === 401) return 401;
  const expected = challengeMac(token, 'slot-res', challenge, nonce, `${answer.status}\n${answer.body}`);
  return macMatches(expected, answer.mac) ? answer.status : -1;
}
