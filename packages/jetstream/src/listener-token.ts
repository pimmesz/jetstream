import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { projectsConfigPath } from './projects-config';

/** The header every Jetstream client puts its token in. */
export const TOKEN_HEADER = 'x-jetstream-token';

/**
 * Enforcement, ON. The token shipped in 2.0.0 — 2.0.2 was the first build that actually reached a
 * deck — and the two-release grace period is long past, so an untokened request is now refused on
 * the endpoints that matter. Deliberately NOT all-or-nothing: `isAuthorized` keeps the status feed
 * open, so a hook that predates the token can never black out someone's board.
 * A WRONG token has always been rejected; only a client older than the token sends nothing at all.
 */
export const ENFORCE_TOKEN = true;

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
  // Mirrors packages/status/src/listener-token.ts exactly: the env-derived primary, then %APPDATA%
  // on Windows, then the environment-independent path. Omitting APPDATA here (as this list used to)
  // meant a Windows plugin with XDG_CONFIG_HOME set could not READ a token minted under APPDATA.
  const paths = [listenerTokenPath(env, home)];
  const appData = env.APPDATA?.trim();
  if (appData && process.platform === 'win32') {
    paths.push(join(appData, 'jetstream', 'listener-token'));
  }
  paths.push(join(home, '.config', 'jetstream', 'listener-token'));
  return [...new Set(paths)];
}

/**
 * Where a BRAND-NEW token is created. Reading still sweeps every candidate above — this only
 * decides where one is minted when none exists anywhere.
 *
 * `listenerTokenPath` follows `XDG_CONFIG_HOME`, which is normally set in a shell profile and
 * absent from the GUI env, so a plugin started from a shell and one started by the desktop derive
 * DIFFERENT primaries. Each would then mint its own secret, and whichever client holds the other
 * one is rejected as presenting a WRONG token — which the grace period does not forgive, since it
 * only excuses a MISSING one. Minting at a path no environment variable can move makes both sides
 * converge, exactly as `resolveProjectsConfigPath` already does for projects.json.
 *
 * `%APPDATA%` is that path on Windows — desktop-launched processes genuinely see it — and it must
 * win there even when `XDG_CONFIG_HOME` is ALSO set, or the same rival-token split reappears.
 */
export function listenerTokenMintPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim();
    if (appData) return join(appData, 'jetstream', 'listener-token');
  }
  return join(home, '.config', 'jetstream', 'listener-token');
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
/**
 * Create `path` holding `token`, atomically — a COMPLETE temp file `link`ed into place, so no
 * reader can ever see a half-written secret (the gap an exclusive `writeFileSync` leaves open
 * between creating the file and filling it). Returns false when the name already exists, i.e.
 * someone else won the race; never overwrites.
 */
function linkTokenInto(path: string, token: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true }); // a stale temp from a crashed run would keep its old mode
    writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      // Some filesystems have no hard links at all (exFAT, a few network/FUSE mounts). Falling
      // back to the exclusive create this replaced keeps the never-clobber guarantee — we lose
      // only the atomic FILL, which beats failing to produce a token on that machine entirely.
      try {
        writeFileSync(path, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return true;
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw fallbackErr;
      }
    }
  } finally {
    // Drop the temp NAME; when the link succeeded the token file keeps the inode alive.
    rmSync(tmp, { force: true });
  }
}

/** Overwrite `path` with `token`, atomically — a complete temp file renamed over whatever is
 * there. Unlike `link`, `rename` REPLACES, so this is the tool for reconciling a stale file; it
 * leaves no truncate window a reader could see. */
function replaceTokenAt(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The plugin's token, generating one on first run.
 *
 * THE MINT PATH IS AUTHORITATIVE. Every process's candidate list contains it, so it is the only
 * location all of them agree on — whereas an `XDG_CONFIG_HOME`-derived candidate is visible to a
 * shell-launched plugin and invisible to a desktop-launched one. Readers take the FIRST candidate
 * holding a token, so it is not enough to write the right value at the mint path: a stale token at
 * an EARLIER candidate would still win for whoever can see it, and the two sides would disagree
 * (one presenting a token the other does not hold = rejected as WRONG, which even the grace period
 * does not forgive). So this resolves one authoritative token and then RECONCILES every other
 * candidate to it, which is what makes all readers converge no matter whose environment they got.
 */
export function ensureToken(
  path = listenerTokenMintPath(),
  // Injectable so the adopt + reconcile branches are testable without touching the real config dir.
  candidates: string[] = path === listenerTokenMintPath() ? listenerTokenPaths() : [path],
): string {
  const authoritative = resolveAuthoritativeToken(path, candidates);
  // Rewrite any candidate still holding a DIFFERENT token. Best-effort per path: an unwritable
  // stale candidate must not stop us returning a token that works for everyone else.
  for (const candidate of candidates) {
    if (candidate === path) continue;
    const held = readToken([candidate]);
    if (held === undefined || held === authoritative) continue;
    try {
      replaceTokenAt(candidate, authoritative);
    } catch {
      // Leave it; doctor reports the mismatch rather than the plugin failing to start.
    }
  }
  return authoritative;
}

/** Exactly what we mint: 32 random bytes as hex. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A token we are willing to TRUST — never merely a non-empty file. A truncated write or a
 * hand-edited file must not be adopted, and above all must not be PROPAGATED: reconciling other
 * candidates to a one-character "token" would spread it everywhere and silently reduce
 * authentication to a value anyone could guess. Anything malformed is treated as absent and healed.
 */
function validToken(paths: string[]): string | undefined {
  // Check each candidate in turn rather than validating whatever `readToken` returns first: a
  // malformed file at an early path would otherwise MASK a perfectly good token at a later one,
  // and we would mint a rival and overwrite the token processes are already holding.
  for (const path of paths) {
    const raw = readToken([path]);
    if (raw !== undefined && TOKEN_PATTERN.test(raw)) return raw;
  }
  return undefined;
}

/** Decide which token wins: the mint path's, else one adopted from another candidate and copied
 * there, else a freshly minted one. Always ends with the value that is actually AT the mint path. */
function resolveAuthoritativeToken(path: string, candidates: string[]): string {
  const atMint = validToken([path]);
  if (atMint) return atMint;

  // Adopt a token from another candidate rather than minting a rival, and copy it to the mint path
  // so the processes that cannot see that candidate still find it.
  const existing = validToken(candidates);
  if (existing) {
    try {
      if (linkTokenInto(path, existing)) return existing;
      // The name already existed. Either another process minted a real token first — THEIRS wins,
      // since the mint path is the one location every reader agrees on — or what is there is blank
      // or malformed, in which case leaving it would send the next process off to mint a rival.
      const winner = validToken([path]);
      if (winner) return winner;
      replaceTokenAt(path, existing);
      return validToken([path]) ?? existing;
    } catch {
      return existing; // unwritable mint path — a working token still beats no token
    }
  }

  const minted = randomBytes(32).toString('hex');
  if (linkTokenInto(path, minted)) return minted;
  const winner = validToken([path]);
  if (winner) return winner;
  // Blank or malformed: heal it, so a corrupted file cannot wedge authentication forever.
  replaceTokenAt(path, minted);
  return validToken([path]) ?? minted;
}

/**
 * Do all candidates that hold a token hold the SAME one? A split here is exactly the failure the
 * mint-path reconcile exists to prevent, and it is invisible at runtime: the plugin serves its own
 * token while a hook whose environment resolves a different candidate sends another and is refused
 * on every endpoint. Doctor reports it, so a reconcile that could not write says so out loud.
 */
export function tokensAgree(paths: string[] = listenerTokenPaths()): boolean {
  const held = paths.map((p) => readToken([p])).filter((token) => token !== undefined);
  return new Set(held).size <= 1;
}

/**
 * The candidate the token was actually found at, or the mint path when there is none yet.
 * Doctor reports on THIS file: checking a derived primary would inspect a path the token may not
 * be at, and report a perfectly good token as missing or world-readable.
 */
export function tokenPathInUse(paths: string[] = listenerTokenPaths()): string {
  for (const path of paths) {
    try {
      if (readFileSync(path, 'utf8').trim() !== '') return path;
    } catch {
      // next candidate
    }
  }
  return listenerTokenMintPath();
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
  // The same reasoning covers BOTH remaining verdicts, so it does not single out 'no-secret': a
  // stale untokened hook loses /permission and /slot, but keeps painting keys. The residual is a
  // board that can be lied to by a local process — already the accepted price of serving /hook
  // unauthenticated, and far cheaper than going dark on everyone who has not re-installed.
  return endpoint === 'status';
}

/** Is the token file readable only by its owner? Group/world-readable defeats the point. */
export function tokenIsPrivate(path = tokenPathInUse()): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}
