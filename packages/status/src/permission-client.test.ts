import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CHALLENGE_HEADER,
  MAC_HEADER,
  NONCE_HEADER,
  challengeMac,
  fetchChallenge,
  permissionMac,
  postPermission,
  runPermissionHook,
  type PermissionHookDeps,
} from './permission-client';
import { permissionDecisionJson } from './permission';

const REQUEST = '{"session_id":"s","tool_name":"Bash"}';
const CHALLENGE = 'c0'.repeat(32);

/** A hook run against a fake plugin: `answer` decides what comes back for the request it received. */
async function run(
  answer: (headers: Record<string, string>) => { body: string; mac: unknown },
  over: Partial<PermissionHookDeps> = {},
): Promise<{ out: string[]; sent: Array<Record<string, string>> }> {
  const out: string[] = [];
  const sent: Array<Record<string, string>> = [];
  await runPermissionHook({
    env: {},
    readStdin: async () => REQUEST,
    readToken: () => 'secret',
    getChallenge: async () => CHALLENGE,
    nonce: () => 'n1',
    post: async (_body, headers) => {
      sent.push(headers);
      return answer(headers);
    },
    write: (s) => out.push(s),
    ...over,
  });
  return { out, sent };
}

describe('runPermissionHook', () => {
  it('re-emits a correctly signed decision from the canonical writer, and never sends the token', async () => {
    const decision = permissionDecisionJson('allow');
    const { out, sent } = await run(() => ({ body: decision, mac: challengeMac('secret', 'res', CHALLENGE, 'n1', decision) }));
    expect(out).toEqual([permissionDecisionJson('allow')]);
    expect(sent[0]).toEqual({
      [CHALLENGE_HEADER]: CHALLENGE,
      [NONCE_HEADER]: 'n1',
      [MAC_HEADER]: challengeMac('secret', 'req', CHALLENGE, 'n1', REQUEST),
    });
    expect(JSON.stringify(sent)).not.toContain('secret');
  });

  it('prints nothing for an unsigned or wrongly signed answer (a port squatter)', async () => {
    const decision = permissionDecisionJson('allow');
    expect((await run(() => ({ body: decision, mac: undefined }))).out).toEqual([]);
    expect((await run(() => ({ body: decision, mac: challengeMac('guess', 'res', CHALLENGE, 'n1', decision) }))).out).toEqual([]);
    // A request MAC replayed as the response MAC is refused too.
    expect((await run((h) => ({ body: decision, mac: h[MAC_HEADER] }))).out).toEqual([]);
    // So is an answer in the 4.1.0 format, which carries no challenge.
    expect((await run(() => ({ body: decision, mac: permissionMac('secret', 'res', 'n1', decision) }))).out).toEqual([]);
  });

  it("prints nothing for a decision signed over another client's nonce under the same challenge", async () => {
    // A squatter picks the challenge, so it can give two hooks the same one; the nonce keeps their answers apart.
    const decision = permissionDecisionJson('allow');
    const forOther = challengeMac('secret', 'res', CHALLENGE, 'n2', decision);
    expect((await run(() => ({ body: decision, mac: forOther }))).out).toEqual([]);
  });

  it('prints nothing for a signed answer that is not a recognised decision', async () => {
    const hostile = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}},"extra":"x"}';
    const junk = 'not json';
    const signed = (body: string) => () => ({ body, mac: challengeMac('secret', 'res', CHALLENGE, 'n1', body) });
    expect((await run(signed(junk))).out).toEqual([]);
    // A valid shape is re-built, so extra fields from the socket never reach Claude.
    expect((await run(signed(hostile))).out).toEqual([permissionDecisionJson('allow')]);
  });

  it('signs a nonce that carries its send time', async () => {
    const before = Date.now();
    const { sent } = await run(() => ({ body: '', mac: undefined }), { nonce: undefined });
    const nonce = sent[0]?.[NONCE_HEADER] ?? '';
    expect(nonce).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(Number(nonce.split('.')[0])).toBeGreaterThanOrEqual(before);
    expect(Number(nonce.split('.')[0])).toBeLessThanOrEqual(Date.now());
    expect(sent[0]?.[MAC_HEADER]).toBe(challengeMac('secret', 'req', CHALLENGE, nonce, REQUEST));
  });

  it('does not ask at all without a token, or for a jetstream chat run', async () => {
    const never = (): never => {
      throw new Error('must not post');
    };
    expect((await run(never, { readToken: () => undefined })).sent).toEqual([]);
    expect((await run(never, { env: { JETSTREAM_SKIP_DECK: '1' } })).sent).toEqual([]);
  });

  it('never posts without a well-formed challenge, so a squatter cannot get an unchallenged request to replay', async () => {
    const never = (): never => {
      throw new Error('must not post');
    };
    for (const challenge of [undefined, 'zz', 'a'.repeat(1024 * 1024)]) {
      expect((await run(never, { getChallenge: async () => challenge })).sent).toEqual([]);
    }
  });
});

describe('the hook transport', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  /** A loopback server answering every request with `answer`; resolves its port. */
  async function listen(answer: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
    const s = createServer(answer);
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const addr = s.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    return addr.port;
  }

  /** Answer 200, then one byte every 50 ms until the client hangs up. */
  const drip = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200);
    const timer = setInterval(() => res.write('a'), 50);
    res.on('close', () => clearInterval(timer));
  };

  /** `promise`, or 'still pending' once `ms` has passed, so a hang fails its test instead of timing it out. */
  function within<T>(ms: number, promise: Promise<T>): Promise<T | 'still pending'> {
    return Promise.race([promise, new Promise<'still pending'>((resolve) => setTimeout(() => resolve('still pending'), ms))]);
  }

  it('fetches the challenge and posts the request, keeping the answer and its MAC', async () => {
    const port = await listen((req, res) => {
      if (req.method === 'GET') return res.end(CHALLENGE);
      res.writeHead(200, { [MAC_HEADER]: 'm1' });
      req.pipe(res); // echo the request back
    });
    expect(await fetchChallenge(port, 300)).toBe(CHALLENGE);
    expect(await postPermission(port, REQUEST, {}, 300)).toEqual({ body: REQUEST, mac: 'm1' });
  });

  // The socket timeout only measures silence, so every dripped byte would restart it.
  it('gives up on a challenge dripped one byte at a time by its deadline', async () => {
    const port = await listen(drip);
    const started = Date.now();
    expect(await within(2_000, fetchChallenge(port, 300))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives up on a decision dripped one byte at a time by its deadline', async () => {
    const port = await listen(drip);
    const started = Date.now();
    expect(await within(2_000, postPermission(port, REQUEST, {}, 300))).toEqual({ body: '', mac: undefined });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
