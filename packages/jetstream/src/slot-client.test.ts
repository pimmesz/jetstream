import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CHALLENGE_HEADER, MAC_HEADER, NONCE_HEADER, challengeMac } from '@pimmesz/jetstream-status';
import { pluginAlive, sendSlot } from './slot-client';
import { startHookServer } from './server';
import { isAuthorized, TOKEN_HEADER } from './listener-token';

const TOKEN = 'a'.repeat(64);
let config: string;
let server: Server | undefined;

// Point the token lookup at a temp dir, so the test never reads the real config.
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'jetstream-slot-'));
  vi.stubEnv('HOME', config);
  vi.stubEnv('XDG_CONFIG_HOME', config);
});

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(config, { recursive: true, force: true });
});

function writeToken(): void {
  mkdirSync(join(config, 'jetstream'), { recursive: true });
  writeFileSync(join(config, 'jetstream', 'listener-token'), TOKEN);
}

/** Point the client at a listening server's port. */
function aimAt(s: Server): void {
  const addr = s.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  vi.stubEnv('JETSTREAM_PORT', String(addr.port));
}

/** The real listener, gated the way the plugin gates it. */
async function plugin(seen: unknown[], key = TOKEN): Promise<Server> {
  const s = await startHookServer(0, {
    onPayload: () => {},
    authorize: (headers, endpoint) => isAuthorized(headers, key, undefined, endpoint),
    permissionKey: () => key,
    onSlot: async (raw) => {
      seen.push(raw);
      return { status: 200, body: '{}' };
    },
  });
  aimAt(s);
  return s;
}

/** A fake listener on the port: `challenge` answers GET /challenge, and every POST is recorded and
 * handed to `answer`, by default a 200 with no MAC, the way a process squatting the port would. */
async function squatter(
  challenge: (res: ServerResponse) => void,
  answer: (res: ServerResponse) => void = (res) => {
    res.writeHead(200);
    res.end('{}');
  },
): Promise<{ posts: Array<{ headers: IncomingHttpHeaders; body: string }>; connections: Set<number | undefined> }> {
  const posts: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const connections = new Set<number | undefined>();
  server = createServer((req, res) => {
    connections.add(req.socket.remotePort);
    if (req.method === 'GET' && req.url === '/challenge') return challenge(res);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      posts.push({ headers: req.headers, body });
      answer(res);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  aimAt(server);
  return { posts, connections };
}

/** `promise`, or 'still pending' once `ms` has passed, so a hang fails its test instead of timing it out. */
function within<T>(ms: number, promise: Promise<T>): Promise<T | 'still pending'> {
  return Promise.race([promise, new Promise<'still pending'>((resolve) => setTimeout(() => resolve('still pending'), ms))]);
}

/** Answer GET /challenge with a well-formed challenge. */
function freshChallenge(res: ServerResponse): void {
  res.writeHead(200);
  res.end(randomBytes(32).toString('hex'));
}

describe('sendSlot', () => {
  it('signs the edit and never sends the token, and does not believe an unsigned answer', async () => {
    writeToken();
    const issued = randomBytes(32).toString('hex');
    const { posts, connections } = await squatter((res) => {
      res.writeHead(200);
      res.end(issued);
    });
    // A squatter can answer 200 but cannot sign it, so chat must not report the edit applied.
    expect(await sendSlot({ coord: 'a1', kind: 'app', app: '/Applications/Café.app' })).toBe(-1);
    const headers = posts[0]?.headers ?? {};
    expect(headers[TOKEN_HEADER]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
    expect(headers[CHALLENGE_HEADER]).toBe(issued);
    const nonce = String(headers[NONCE_HEADER]);
    expect(nonce).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(headers[MAC_HEADER]).toBe(challengeMac(TOKEN, 'slot', issued, nonce, posts[0]?.body ?? ''));
    // The edit went out on its own connection, not the one that fetched the challenge.
    expect(connections.size).toBe(2);
  });

  it('never falls back to the unchallenged format when /challenge is missing', async () => {
    writeToken();
    const { posts } = await squatter((res) => {
      res.writeHead(404);
      res.end();
    });
    // 401 makes chat say the plugin is older than this CLI; the edit itself is never sent.
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(401);
    expect(posts).toEqual([]);
  });

  it('refuses a challenge that is not 64 hex without sending the edit', async () => {
    writeToken();
    const { posts } = await squatter((res) => {
      res.writeHead(200);
      res.end('<html>\nhello</html>'); // a newline would also break the header the edit carries it in
    });
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(401);
    expect(posts).toEqual([]);
  });

  it('gives up with -1 on an answer that never ends', async () => {
    writeToken();
    await squatter(freshChallenge, (res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 'x');
      const pump = (): void => {
        if (!res.destroyed) res.write(chunk, () => setImmediate(pump));
      };
      pump();
    });
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(-1);
  });

  // The socket timeout only measures silence, so every dripped byte would restart it.
  it('gives up with -1 by its deadline on an answer dripped one byte at a time', async () => {
    writeToken();
    await squatter(freshChallenge, (res) => {
      res.writeHead(200);
      const drip = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(drip));
    });
    const started = Date.now();
    expect(await within(2_000, sendSlot({ coord: 'a1', kind: 'empty' }, 300))).toBe(-1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('resolves -1 when the answer is cut off mid-body', async () => {
    writeToken();
    await squatter(freshChallenge, (res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('{"partial"', () => res.socket?.destroy());
    });
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(-1);
  });

  // -1 makes chat roll the edit back, while 401 would tell it nothing changed.
  it('resolves -1, not 401, when the edit is dropped without an answer', async () => {
    writeToken();
    const { posts } = await squatter(freshChallenge, (res) => res.socket?.destroy());
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(-1);
    expect(posts).toHaveLength(1);
  });

  it('resolves -1 when nothing is listening', async () => {
    writeToken();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    aimAt(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(-1);
  });

  it('lands on the real listener, which takes the signature in place of the token', async () => {
    writeToken();
    const seen: unknown[] = [];
    server = await plugin(seen);
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(200);
    expect(seen).toEqual([{ coord: 'a1', kind: 'empty' }]);
  });

  it('is refused without a token to sign with', async () => {
    const seen: unknown[] = [];
    server = await plugin(seen);
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(401);
    expect(seen).toEqual([]);
  });

  it("believes the plugin's unsigned 401 for a token it does not hold", async () => {
    writeToken();
    const seen: unknown[] = [];
    server = await plugin(seen, 'b'.repeat(64));
    expect(await sendSlot({ coord: 'a1', kind: 'empty' })).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe('pluginAlive', () => {
  it('is true for a listener that answers /health', async () => {
    server = await plugin([]);
    expect(await pluginAlive(300)).toBe(true);
  });

  // A 102 interim answer carries no body, so no byte cap would ever end this one.
  it('gives up with false by its deadline when /health only ever answers 102 Processing', async () => {
    await squatter(freshChallenge, (res) => {
      const drip = setInterval(() => res.writeProcessing(), 50);
      res.on('close', () => clearInterval(drip));
    });
    const started = Date.now();
    expect(await within(2_000, pluginAlive(300))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
