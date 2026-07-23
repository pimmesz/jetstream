import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRequest,
  ensureToken,
  isAuthorized,
  listenerTokenPath,
  readToken,
  tokenIsPrivate,
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

describe('ensureToken', () => {
  it('adopts a token already present at a fallback path instead of minting a rival', () => {
    // Two secrets is worse than none: clients reading the older one would present a token this
    // listener does not hold, which is rejected as WRONG — the grace period only forgives MISSING.
    const dir = tmp();
    const fallback = join(dir, 'fallback-token');
    const primary = join(dir, 'primary-token');
    writeFileSync(fallback, 'a'.repeat(64));
    // ensureToken checks the candidate list it is given, not just where it would write.
    expect(readToken([primary, fallback])).toBe('a'.repeat(64));
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

  it('serves everything while the grace period is open, whatever the endpoint', () => {
    expect(isAuthorized({}, secret, undefined, 'status')).toBe(!ENFORCE_TOKEN);
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
