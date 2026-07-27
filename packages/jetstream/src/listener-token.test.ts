import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRequest,
  ensureToken,
  isAuthorized,
  listenerTokenMintPath,
  listenerTokenPath,
  readToken,
  tokenIsPrivate,
  tokensAgree,
  tokensMatch,
  TOKEN_HEADER,
  ENFORCE_TOKEN,
} from './listener-token';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-token-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('listenerTokenPath', () => {
  it('sits beside projects.json so one config dir holds both', () => {
    const path = listenerTokenPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me');
    expect(path).toBe(join('/cfg', 'jetstream', 'listener-token'));
  });

  it('falls back to ~/.config/jetstream', () => {
    expect(listenerTokenPath({}, '/home/me')).toBe(
      join('/home/me', '.config', 'jetstream', 'listener-token'),
    );
  });
});

describe('listenerTokenMintPath', () => {
  it('mints at the environment-independent path even when XDG_CONFIG_HOME points elsewhere', () => {
    // XDG_CONFIG_HOME is normally set in a shell profile and absent from the GUI env, so minting
    // at the derived primary let the plugin and a shell-spawned hook create two rival secrets.
    expect(listenerTokenMintPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(
      join('/home/me', '.config', 'jetstream', 'listener-token'),
    );
    // READING still prefers the XDG path, so a token already minted there is adopted, not orphaned.
    expect(listenerTokenPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(
      join('/cfg', 'jetstream', 'listener-token'),
    );
  });

  it('is the ordinary config path when nothing overrides it', () => {
    expect(listenerTokenMintPath({}, '/home/me')).toBe(
      join('/home/me', '.config', 'jetstream', 'listener-token'),
    );
  });
});

describe('ensureToken', () => {
  it('adopts a token already present at a fallback path instead of minting a rival', () => {
    // Two secrets is worse than none: clients reading the older one would present a token this
    // listener does not hold, which is rejected as WRONG — the grace period only forgives MISSING.
    const dir = tmp();
    const fallback = join(dir, 'fallback-token');
    const primary = join(dir, 'primary-token');
    writeFileSync(fallback, 'a'.repeat(64));
    // Drive ensureToken itself, not just readToken: the adopt branch is what must not mint.
    expect(ensureToken(primary, [primary, fallback])).toBe('a'.repeat(64));
    // ...and it must PROPAGATE the adopted token to the mint path. Leaving it only at the
    // candidate this process happens to see (an XDG path a desktop-launched plugin cannot) means
    // the next run finds nothing there, mints a rival, and rejects every client on the old one.
    expect(readToken(primary)).toBe('a'.repeat(64));
  });

  it('reconciles a stale earlier candidate to the mint path, so every reader converges', () => {
    // The race this closes: a process adopts token A from an XDG path while another mints B at the
    // mint path. Readers take the FIRST candidate they can see, so hooks with XDG in their
    // environment would keep sending A while the plugin holds B — and a WRONG token is refused on
    // every endpoint, dark board included. The mint path is the one location every candidate list
    // contains, so it wins and the stale file is rewritten to match.
    const dir = tmp();
    const stale = join(dir, 'xdg-token');
    const mint = join(dir, 'mint-token');
    writeFileSync(mint, 'b'.repeat(64));
    writeFileSync(stale, 'a'.repeat(64));
    // Candidate order puts the stale path FIRST, exactly as a reader with XDG set would see it.
    expect(ensureToken(mint, [stale, mint])).toBe('b'.repeat(64));
    expect(readToken(stale)).toBe('b'.repeat(64)); // rewritten, so the early candidate agrees
    expect(readToken([stale, mint])).toBe('b'.repeat(64)); // a hook now reads the same token
  });

  it('propagates an adopted token to the mint path AND leaves the source agreeing', () => {
    // The upgrade path: a token minted by an older release sits only at the XDG candidate.
    const dir = tmp();
    const stale = join(dir, 'xdg-token');
    const mint = join(dir, 'mint-token');
    writeFileSync(stale, 'a'.repeat(64));
    expect(ensureToken(mint, [stale, mint])).toBe('a'.repeat(64));
    expect(readToken(mint)).toBe('a'.repeat(64)); // copied, so a process without XDG finds it
    expect(readToken(stale)).toBe('a'.repeat(64)); // untouched — it already agreed
  });

  it('never adopts or propagates a malformed token', () => {
    // A truncated write or a hand-edited file must not become the secret — and above all must not
    // be copied over a VALID token at another candidate, which would spread a guessable one.
    const dir = tmp();
    const stale = join(dir, 'xdg-token');
    const mint = join(dir, 'mint-token');
    writeFileSync(mint, 'x'); // not 64 hex — junk, however non-empty
    writeFileSync(stale, 'a'.repeat(64));
    const token = ensureToken(mint, [stale, mint]);
    expect(token).toBe('a'.repeat(64)); // the real token wins over the junk
    expect(readToken(mint)).toBe('a'.repeat(64)); // junk healed, not enthroned
    expect(readToken(stale)).toBe('a'.repeat(64)); // and never overwritten with 'x'
  });

  it('looks past a malformed early candidate to a valid later one', () => {
    // A junk file at the first candidate must not MASK a real token further down the list: minting
    // a rival there would overwrite the token every running process is already holding.
    const dir = tmp();
    const junk = join(dir, 'junk-token');
    const mint = join(dir, 'mint-token');
    const home = join(dir, 'home-token');
    writeFileSync(junk, 'x');
    writeFileSync(home, 'a'.repeat(64));
    expect(ensureToken(mint, [junk, mint, home])).toBe('a'.repeat(64));
    expect(readToken(mint)).toBe('a'.repeat(64)); // adopted, not freshly minted
    expect(readToken(junk)).toBe('a'.repeat(64)); // the junk is reconciled away
  });

  it('heals a blank mint path while adopting, so the next process finds it', () => {
    // Without this the adopted token stays only at the candidate this process can see, and a
    // process that resolves a different environment mints a rival on its next start.
    const dir = tmp();
    const stale = join(dir, 'xdg-token');
    const mint = join(dir, 'mint-token');
    writeFileSync(mint, ''); // exists, so the exclusive create fails — but holds nothing
    writeFileSync(stale, 'a'.repeat(64));
    expect(ensureToken(mint, [stale, mint])).toBe('a'.repeat(64));
    expect(readToken(mint)).toBe('a'.repeat(64));
  });

  it('ignores a blank fallback and mints, rather than adopting nothing', () => {
    const dir = tmp();
    const fallback = join(dir, 'fallback-token');
    const primary = join(dir, 'primary-token');
    writeFileSync(fallback, '   \n'); // present but empty — not a token to adopt
    const token = ensureToken(primary, [primary, fallback]);
    expect(token).toHaveLength(64);
    expect(readToken(primary)).toBe(token);
  });

  it('leaves no temp file behind — the token appears complete or not at all', () => {
    // The token is linked into place from a fully-written temp file, so a reader can never observe
    // a half-written secret. The temp name must not survive the call either.
    const dir = tmp();
    const path = join(dir, 'listener-token');
    ensureToken(path, [path]);
    expect(readdirSync(dir)).toEqual(['listener-token']);
  });

  it('creates a 32-byte token owner-only, and is idempotent', () => {
    const path = join(tmp(), 'nested', 'listener-token');
    const first = ensureToken(path);
    expect(first).toHaveLength(64); // 32 bytes hex
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    expect(tokenIsPrivate(path)).toBe(true);
    expect(ensureToken(path)).toBe(first); // never rotates an existing token out from under live hooks
  });

  it('reads back exactly what it wrote, with no trailing newline to strip', () => {
    const path = join(tmp(), 'listener-token');
    const written = ensureToken(path);
    expect(readToken(path)).toBe(written);
    expect(readFileSync(path, 'utf8')).toBe(written); // byte-identical: a stray \n would break the compare
  });

  it('heals a blank/interrupted token file rather than returning a token it never persisted', () => {
    // The exclusive-create mint (flag 'wx') would EEXIST on a pre-existing blank file; ensure that
    // path still writes the token to disk, so a corrupted file can't wedge auth (clients 401 forever).
    const path = join(tmp(), 'listener-token');
    writeFileSync(path, ''); // a prior write created the file but never wrote the token
    const token = ensureToken(path);
    expect(token).toHaveLength(64);
    expect(readToken(path)).toBe(token); // healed in place, so a client can read the token we returned
  });

  it('treats a missing or blank file as no token, never throwing', () => {
    const dir = tmp();
    expect(readToken(join(dir, 'absent'))).toBeUndefined();
    const blank = join(dir, 'blank');
    writeFileSync(blank, '   \n');
    expect(readToken(blank)).toBeUndefined();
    expect(tokenIsPrivate(join(dir, 'absent'))).toBe(false);
  });
});

describe('tokensAgree', () => {
  it('is true when candidates hold the same token, or only one holds anything', () => {
    const dir = tmp();
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    expect(tokensAgree([a, b])).toBe(true); // neither exists yet
    writeFileSync(a, 'a'.repeat(64));
    expect(tokensAgree([a, b])).toBe(true); // one holds it, the other is simply absent
    writeFileSync(b, 'a'.repeat(64));
    expect(tokensAgree([a, b])).toBe(true);
  });

  it('is false when two candidates hold DIFFERENT tokens', () => {
    // The split-brain doctor must surface: plugin serves one, a hook sends the other, every
    // request is refused as a WRONG token, and nothing else in the product says why.
    const dir = tmp();
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeFileSync(a, 'a'.repeat(64));
    writeFileSync(b, 'b'.repeat(64));
    expect(tokensAgree([a, b])).toBe(false);
  });
});

describe('tokensMatch', () => {
  it('accepts an exact match and rejects near-misses, including differing lengths', () => {
    // A length mismatch is the case that makes timingSafeEqual THROW — guarding it is the point.
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
    expect(() => tokensMatch('abc123', 'abc')).not.toThrow();
    expect(tokensMatch('abc123', 'abc')).toBe(false);
    expect(tokensMatch('abc123', '')).toBe(false);
  });
});

describe('classifyRequest', () => {
  const secret = 'a'.repeat(64);

  it('separates a correct token, a legacy client, and a wrong token', () => {
    expect(classifyRequest({ [TOKEN_HEADER]: secret }, secret)).toBe('ok');
    expect(classifyRequest({}, secret)).toBe('legacy');
    expect(classifyRequest({ [TOKEN_HEADER]: 'b'.repeat(64) }, secret)).toBe('bad');
  });

  it('treats an empty or repeated header as legacy, not as a match', () => {
    // node gives an ARRAY for a repeated header — it must never be compared as a string.
    expect(classifyRequest({ [TOKEN_HEADER]: '' }, secret)).toBe('legacy');
    expect(classifyRequest({ [TOKEN_HEADER]: [secret, 'x'] }, secret)).toBe('legacy');
  });

  it('reports no-secret — not legacy — when this side holds no token', () => {
    // The distinction matters at enforcement time: 'legacy' is a client that predates the token
    // (reject once the grace period ends), 'no-secret' is US having nothing to check against.
    expect(classifyRequest({ [TOKEN_HEADER]: secret }, undefined)).toBe('no-secret');
    expect(classifyRequest({}, undefined)).toBe('no-secret');
  });
});

describe('isAuthorized', () => {
  const secret = 'a'.repeat(64);

  it('always serves a correct token and always rejects a wrong one', () => {
    expect(isAuthorized({ [TOKEN_HEADER]: secret }, secret)).toBe(true);
    // A wrong token is rejected in the grace period too — no legitimate client sends one.
    expect(isAuthorized({ [TOKEN_HEADER]: 'b'.repeat(64) }, secret)).toBe(false);
  });

  it('serves an untokened request only while the grace period is open, and reports it once', () => {
    let noticed = 0;
    expect(isAuthorized({}, secret, () => noticed++)).toBe(!ENFORCE_TOKEN);
    expect(noticed).toBe(1); // the caller gets told, so doctor/logs can surface the open window
  });

  it('does not report a wrong token as a legacy client', () => {
    let noticed = 0;
    isAuthorized({ [TOKEN_HEADER]: 'b'.repeat(64) }, secret, () => noticed++);
    expect(noticed).toBe(0); // an attacker must not be able to spam the "upgrade your hooks" log
  });

  it('keeps the status feed alive for an untokened client, but refuses the sensitive endpoints', () => {
    // The endpoint split covers BOTH untokened verdicts, not just no-secret. A hook older than the
    // token keeps painting keys — refusing /hook is what turns "your hooks are stale" into a black
    // board — while /permission and /slot, the two reasons to authenticate at all, are refused.
    expect(isAuthorized({}, secret, undefined, 'status')).toBe(true);
    expect(isAuthorized({}, secret, undefined, 'sensitive')).toBe(!ENFORCE_TOKEN);
  });

  // The policy that matters at the flip, asserted for BOTH arms so flipping the flag is a
  // one-line change with the test already written.
  it('with no secret on disk, keeps the status feed alive but refuses the sensitive endpoints', () => {
    // Rejecting everything would black out the board of a user whose home is merely read-only;
    // serving everything would let anyone who can provoke the no-secret state (filling a shared
    // disk before first start) switch authentication off. Split by what is at stake instead.
    expect(isAuthorized({}, undefined, undefined, 'status')).toBe(true);
    expect(isAuthorized({}, undefined, undefined, 'sensitive')).toBe(!ENFORCE_TOKEN);
  });

  it('a correct token is served on every endpoint, a wrong one on none', () => {
    expect(isAuthorized({ [TOKEN_HEADER]: secret }, secret, undefined, 'sensitive')).toBe(true);
    expect(isAuthorized({ [TOKEN_HEADER]: 'b'.repeat(64) }, secret, undefined, 'status')).toBe(false);
  });
});
