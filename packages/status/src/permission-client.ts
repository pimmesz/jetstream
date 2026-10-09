import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { parsePermissionDecision } from './permission';

/**
 * The permission hook's exchange with the plugin, signed both ways so the shared token never
 * travels (DECISIONS.md 2026-07-25 #3). The hook first asks the plugin for a single-use challenge,
 * then sends a nonce and an HMAC over the challenge and the request; the plugin answers with an HMAC
 * over the decision. A process that squats the port cannot read the 0600 token file, so it can
 * neither learn the token nor forge an answer: the hook then prints nothing and Claude shows its
 * own dialog. A request it captured carries its own challenge, which the real plugin never issued.
 */
export const NONCE_HEADER = 'x-jetstream-nonce';
export const MAC_HEADER = 'x-jetstream-mac';
export const CHALLENGE_HEADER = 'x-jetstream-challenge';

/** A fresh nonce: `<send time in ms>.<32 random hex>`. The MAC covers it and binds the answer to this
 * request. In the 4.1.0 format the plugin also refuses a stale or repeated one, so a captured request
 * cannot be replayed (v2 leaves that to the challenge). Same shape in jetstream's server.ts (which
 * parses it) and slot-client.ts. */
export function newNonce(now = Date.now()): string {
  return `${now}.${randomBytes(16).toString('hex')}`;
}

/** HMAC-SHA256 over one message. `kind` keeps a MAC made for one message from being accepted as
 * another: 'req' and 'res' are the two directions of /permission, 'slot' a signed live board edit.
 * The 4.1.0 format: the plugin still accepts it from older clients, but current ones use challengeMac. */
export function permissionMac(token: string, kind: 'req' | 'res' | 'slot', nonce: string, body: string): string {
  return createHmac('sha256', token).update(`${kind}\n${nonce}\n${body}`).digest('hex');
}

/** Whether a value has the shape of a plugin challenge: 64 lowercase hex (challengeStore in jetstream's server.ts). */
export function isChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** HMAC-SHA256 for the challenge format (v2). The leading `v2` line keeps it from ever matching a
 * permissionMac. The client's own nonce stays in, because a squatter picks the challenge and could hand
 * two clients the same one: an answer must only verify for the request that asked for it. */
export function challengeMac(
  token: string,
  kind: 'req' | 'res' | 'slot' | 'slot-res',
  challenge: string,
  nonce: string,
  text: string,
): string {
  return createHmac('sha256', token).update(`v2\n${kind}\n${challenge}\n${nonce}\n${text}`).digest('hex');
}

/** Constant-time comparison of a received MAC against the expected one. */
export function macMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PermissionHookDeps {
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  readToken: () => string | undefined;
  /** GET a single-use challenge from the plugin; undefined when it gives none (down, or older than v2). */
  getChallenge: () => Promise<string | undefined>;
  /** POST the request; resolves with the response body and its MAC header ('' / undefined when none). */
  post: (body: string, headers: Record<string, string>) => Promise<{ body: string; mac: unknown }>;
  write: (out: string) => void;
  nonce?: () => string;
}

/** The PermissionRequest hook, with every side effect injected so its contract is testable. */
export async function runPermissionHook(deps: PermissionHookDeps): Promise<void> {
  // `jetstream chat` runs its own `claude -p` with this marker: its prompts are not the user's to
  // answer on the deck (headless runs fire PermissionRequest since Claude Code 2.1.268).
  if (deps.env.JETSTREAM_SKIP_DECK === '1') return;
  const body = await deps.readStdin();
  if (!body.trim()) return;
  // Without the token the answer cannot be verified, so do not ask: Claude's own dialog decides.
  const token = deps.readToken();
  if (!token) return;
  // Never fall back to the unchallenged 4.1.0 format: a squatter could refuse the challenge on purpose
  // and collect a request it can replay. A plugin older than v2 then leaves the prompt to Claude.
  const challenge = await deps.getChallenge();
  if (!isChallenge(challenge)) return;
  const nonce = (deps.nonce ?? newNonce)();
  const answer = await deps.post(body, {
    [CHALLENGE_HEADER]: challenge,
    [NONCE_HEADER]: nonce,
    [MAC_HEADER]: challengeMac(token, 'req', challenge, nonce, body),
  });
  if (!macMatches(challengeMac(token, 'res', challenge, nonce, answer.body), answer.mac)) return;
  // NEVER write the socket's bytes through: Claude treats this stdout as the authoritative
  // decision, so the shape is validated and re-emitted from our own canonical writer.
  const safe = parsePermissionDecision(answer.body);
  if (safe) deps.write(safe);
}

/** A challenge is 64 hex characters; a longer answer is not the plugin talking. */
const MAX_CHALLENGE_LENGTH = 128;

/** GET a single-use challenge from the plugin on `port`, or undefined on any error, non-200 or oversized answer. */
export function fetchChallenge(port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    // A deadline for the whole request, not a socket timeout: that one only measures silence, so a
    // squatter sending a byte at a time would hold it open. The abort lands in 'error' below.
    const signal = AbortSignal.timeout(timeoutMs);
    const req = request(
      // agent: false gives this GET its own connection, closed after the answer, so postPermission never reuses it.
      { host: '127.0.0.1', port, path: '/challenge', method: 'GET', agent: false, signal },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(undefined);
          return;
        }
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          out += chunk;
          if (out.length > MAX_CHALLENGE_LENGTH) {
            req.destroy();
            resolve(undefined);
          }
        });
        res.on('end', () => resolve(out));
        res.on('error', () => resolve(undefined)); // the connection dropped mid-answer
      },
    );
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

/** POST the signed permission request to the plugin on `port`; resolves its answer and MAC header,
 * or an empty body and no MAC on any error or timeout. */
export function postPermission(
  port: number,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ body: string; mac: unknown }> {
  return new Promise((resolve) => {
    const signal = AbortSignal.timeout(timeoutMs); // the whole exchange, as in fetchChallenge
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/permission',
        method: 'POST',
        // A fresh connection reaches whoever holds the port now. Reusing the challenge's socket would let a
        // squatter that answered the GET relay a real challenge and keep the signed request for itself.
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
        signal,
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => resolve({ body: out, mac: res.headers[MAC_HEADER] }));
      },
    );
    req.on('error', () => resolve({ body: '', mac: undefined }));
    req.end(body);
  });
}
