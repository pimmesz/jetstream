import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parsePermissionDecision } from './permission';

/**
 * The permission hook's exchange with the plugin, signed both ways so the shared token never
 * travels (DECISIONS.md 2026-07-25 #3). The hook sends a nonce and an HMAC over the request; the
 * plugin answers with an HMAC over the decision. A process that squats the port cannot read the
 * 0600 token file, so it can neither learn the token nor forge an answer: the hook then prints
 * nothing and Claude shows its own dialog.
 */
export const NONCE_HEADER = 'x-jetstream-nonce';
export const MAC_HEADER = 'x-jetstream-mac';

/** A fresh nonce: `<send time in ms>.<32 random hex>`. The MAC covers it, and the plugin refuses a
 * stale or repeated one so a captured request cannot be replayed. Same shape in jetstream's
 * server.ts (which parses it) and slot-client.ts. */
export function newNonce(now = Date.now()): string {
  return `${now}.${randomBytes(16).toString('hex')}`;
}

/** HMAC-SHA256 over one message. `kind` keeps a MAC made for one message from being accepted as
 * another: 'req' and 'res' are the two directions of /permission, 'slot' a signed live board edit. */
export function permissionMac(token: string, kind: 'req' | 'res' | 'slot', nonce: string, body: string): string {
  return createHmac('sha256', token).update(`${kind}\n${nonce}\n${body}`).digest('hex');
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
  const nonce = (deps.nonce ?? newNonce)();
  const answer = await deps.post(body, {
    [NONCE_HEADER]: nonce,
    [MAC_HEADER]: permissionMac(token, 'req', nonce, body),
  });
  if (!macMatches(permissionMac(token, 'res', nonce, answer.body), answer.mac)) return;
  // NEVER write the socket's bytes through: Claude treats this stdout as the authoritative
  // decision, so the shape is validated and re-emitted from our own canonical writer.
  const safe = parsePermissionDecision(answer.body);
  if (safe) deps.write(safe);
}
