import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { projectsConfigPath } from './projects-config';

/** The header every Jetstream client puts its token in. */
export const TOKEN_HEADER = 'x-jetstream-token';

/**
 * Grace period. Hooks installed by an older release send NO token, and Claude Code keeps running
 * them until the user reinstalls — so a MISSING header is still accepted for two releases and
 * `jetstream doctor` warns for the whole window. Flip this to `true` in the second release after
 * the one that introduces the token; from then on an unauthenticated request is rejected.
 * A WRONG token is rejected either way — only a legacy client sends nothing at all.
 */
export const ENFORCE_TOKEN = false;

/** Where the secret lives: beside projects.json, so it follows XDG/APPDATA like the rest of the config. */
export function listenerTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(dirname(projectsConfigPath(env, home)), 'listener-token');
}

/**
 * Every path the token could be at, most-specific first — the same candidate list the hook binaries
 * use (packages/status/src/listener-token.ts). One path is not enough: the plugin runs under the
 * Stream Deck app while the CLI runs from your shell, so an `XDG_CONFIG_HOME` set in a shell profile
 * but absent from the GUI env would make writer and reader disagree, and `jetstream chat` would
 * silently send no token (invisible now, a 401 once enforcement lands).
 */
export function listenerTokenPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const primary = listenerTokenPath(env, home);
  const fallback = join(home, '.config', 'jetstream', 'listener-token');
  return primary === fallback ? [primary] : [primary, fallback];
}

/** The token as stored, or undefined when absent/empty/unreadable everywhere. Never throws — a
 * missing token must degrade to "unauthenticated", not crash the plugin or a hook. */
export function readToken(paths: string | string[] = listenerTokenPaths()): string | undefined {
  for (const path of typeof paths === 'string' ? [paths] : paths) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw !== '') return raw;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

/**
 * The plugin's token, generating one on first run. 32 random bytes, written 0600 so other users on
 * the machine cannot read it.
 *
 * Honest scope — this is a bar-raiser, not a boundary:
 *   - It does NOT stop a process running AS you: it can read the file too.
 *   - It does NOT survive port squatting. The port is fixed and unprivileged, so another local
 *     user who binds 127.0.0.1:41321 BEFORE Stream Deck starts receives the hooks' token in their
 *     own request headers and can replay it afterwards. Closing that needs a transport that
 *     doesn't hand the secret to whoever answers — a 0700 unix socket, or a challenge/response —
 *     which is the shape any future hardening should take. Squatting is loud, though: the plugin
 *     retries the bind for ~90s and then logs that it could not listen.
 *   - What it DOES stop is the easy case this was written for: any other local process that
 *     merely connects to an already-running listener and drives your board.
 * Browser-borne requests are blocked separately by the Origin/Referer guard in server.ts.
 */
export function ensureToken(path = listenerTokenPath()): string {
  // ADOPT a token from any candidate path before minting one. Creating a second secret at the
  // primary path while clients keep reading an older one elsewhere is worse than having none:
  // they would present a token this listener does not hold, which is rejected as WRONG — even
  // during the grace period, which only forgives a MISSING token.
  const candidates = path === listenerTokenPath() ? listenerTokenPaths() : [path];
  const existing = readToken(candidates);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Exclusive create (flag 'wx'): if a racing process minted first during the kill->respawn
    // overlap, our write fails EEXIST and we ADOPT its token instead of writing a rival secret the
    // clients won't be holding — two different tokens would make every request 401 once enforced.
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const winner = readToken(candidates);
    // Adopt only a COMPLETE token (32 bytes hex) — never a partially-written one glimpsed mid-write.
    if (winner && /^[0-9a-f]{64}$/.test(winner)) return winner;
    // The file exists but holds no token (a blank/interrupted prior write): heal it in place, as the
    // non-exclusive write used to, so a corrupted token file can't wedge auth forever.
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  }
}

/** Constant-time compare, length-guarded (timingSafeEqual throws on a length mismatch). */
export function tokensMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type AuthVerdict =
  /** Correct token — always allowed. */
  | 'ok'
  /** No token header at all: a hook from an older release. Allowed during the grace period. */
  | 'legacy'
  /** A token was sent and it is wrong. Never allowed — no legitimate client does this. */
  | 'bad'
  /** THIS SIDE has no token, so there is nothing to check against. Always allowed — see below. */
  | 'no-secret';

/** Classify a request. Pure, so the policy is testable without a socket. */
export function classifyRequest(
  headers: IncomingHttpHeaders,
  expected: string | undefined,
): AuthVerdict {
  if (!expected) return 'no-secret';
  const presented = headers[TOKEN_HEADER];
  if (typeof presented !== 'string' || presented === '') return 'legacy';
  return tokensMatch(expected, presented) ? 'ok' : 'bad';
}

/**
 * How much a given endpoint matters if it is served unauthenticated.
 * - `status` (`/hook`) — lifecycle events that only colour keys. Serving these without a token
 *   costs at most a lying board, and refusing them is what turns a token problem into a DARK one.
 * - `sensitive` (`/permission`, `/slot`) — answering Claude's permission prompts and planting keys.
 *   These are the reasons the listener is authenticated at all.
 */
export type EndpointKind = 'status' | 'sensitive';

/** Should this request be served? `onLegacy` fires per unauthenticated accept so the caller can
 * log it — the only signal that the grace period is still carrying real traffic. */
export function isAuthorized(
  headers: IncomingHttpHeaders,
  expected: string | undefined,
  onLegacy?: () => void,
  endpoint: EndpointKind = 'sensitive',
): boolean {
  const verdict = classifyRequest(headers, expected);
  if (verdict === 'ok') return true;
  if (verdict === 'bad') return false;
  onLegacy?.();
  if (!ENFORCE_TOKEN) return true; // the grace period: a client that predates the token still works
  // Enforcing, and either the client sent nothing ('legacy') or we hold no secret ('no-secret').
  // Split by what is at stake rather than choosing one bad extreme: keep the STATUS feed flowing so
  // a token problem never blacks out the board, but refuse the endpoints that answer permission
  // prompts and plant keys — those are the whole point of authenticating. (Fail-open on everything
  // would let anyone who can provoke the no-secret state — filling a shared disk before first
  // start — switch authentication off; fail-closed on everything darkens the board for a user
  // whose home is simply read-only.)
  return endpoint === 'status' && verdict === 'no-secret';
}

/** Is the token file readable only by its owner? Group/world-readable defeats the point. */
export function tokenIsPrivate(path = listenerTokenPath()): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}
