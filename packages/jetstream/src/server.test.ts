import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHALLENGE_HEADER,
  MAC_HEADER,
  NONCE_HEADER,
  challengeMac,
  permissionDecisionJson,
  permissionMac,
} from '@pimmesz/jetstream-status';
import { challengeStore, nonceMemory, startHookServer } from './server';

/** Raw POST so we can set an `Origin` header: undici's `fetch` silently drops it (forbidden name). */
function rawPost(port: number, path: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Raw GET that can carry an `Origin` header; resolves the status. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function port(s: Server): number {
  const addr = s.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** A nonce in the shape the hook and the CLI send: the send time, then 32 random hex. */
const nonceAt = (ms = Date.now()): string => `${ms}.${randomBytes(16).toString('hex')}`;

/** Headers for a request signed with `key` over `body` in the 4.1.0 format (no challenge). */
const signed = (kind: 'req' | 'slot', body: string, nonce = nonceAt(), key = 'secret'): Record<string, string> => ({
  [NONCE_HEADER]: nonce,
  [MAC_HEADER]: permissionMac(key, kind, nonce, body),
});

/** Headers for a v2 request signed with `key` over `challenge` and `body`. */
const signedV2 = (
  kind: 'req' | 'slot',
  body: string,
  challenge: string,
  nonce = nonceAt(),
  key = 'secret',
): Record<string, string> => ({
  [CHALLENGE_HEADER]: challenge,
  [NONCE_HEADER]: nonce,
  [MAC_HEADER]: challengeMac(key, kind, challenge, nonce, body),
});

/** A fresh challenge from the listener, the way the hook and the CLI ask for one. */
async function challengeFrom(s: Server): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port(s)}/challenge`)).text();
}

/** Run the built permission hook against `hookPort` with a token in a temp config; resolves its stdout. */
async function runHook(hookPort: number, prompt: unknown): Promise<string> {
  const config = mkdtempSync(join(tmpdir(), 'jetstream-hook-'));
  try {
    mkdirSync(join(config, 'jetstream'));
    writeFileSync(join(config, 'jetstream', 'listener-token'), 'secret');
    const hook = createRequire(import.meta.url).resolve('@pimmesz/jetstream-status/dist/permission-hook.js');
    const child = spawn(process.execPath, [hook], {
      env: { PATH: process.env.PATH, HOME: config, XDG_CONFIG_HOME: config, JETSTREAM_PORT: String(hookPort) },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const exited = new Promise((resolve) => child.on('close', resolve));
    // Indented, so a server that MACs a re-serialised body instead of the bytes it got would fail.
    child.stdin.end(JSON.stringify(prompt, null, 2));
    await exited;
    return out;
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

describe('startHookServer', () => {
  it('parses a POSTed hook payload and hands it to onPayload', async () => {
    const seen: unknown[] = [];
    server = await startHookServer(0, { onPayload: (raw) => seen.push(raw) });
    const res = await fetch(`http://127.0.0.1:${port(server)}/hook`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop', cwd: '/p', session_id: 's' }),
    });
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ hook_event_name: 'Stop', cwd: '/p', session_id: 's' }]);
  });

  it('reports a handler failure instead of dropping it as "not JSON"', async () => {
    const errors: string[] = [];
    server = await startHookServer(0, {
      onPayload: () => {
        throw new Error('reducer bug');
      },
      onSlot: async () => {
        throw new Error('render timeout');
      },
      onError: (endpoint, error) => void errors.push(`${endpoint}: ${(error as Error).message}`),
    });
    const hook = await fetch(`http://127.0.0.1:${port(server)}/hook`, { method: 'POST', body: '{"a":1}' });
    expect(hook.status).toBe(204); // the hook still gets its normal answer
    const slot = await fetch(`http://127.0.0.1:${port(server)}/slot`, { method: 'POST', body: '{"coord":"a1"}' });
    expect(slot.status).toBe(500);
    expect(await slot.json()).toHaveProperty('error');
    expect(errors).toEqual(['/hook: reducer bug', '/slot: render timeout']);
  });

  it('drops non-JSON bodies without crashing and 404s other routes', async () => {
    const seen: unknown[] = [];
    server = await startHookServer(0, { onPayload: (raw) => seen.push(raw) });
    const bad = await fetch(`http://127.0.0.1:${port(server)}/hook`, {
      method: 'POST',
      body: 'not json',
    });
    expect(bad.status).toBe(204);
    expect(seen).toEqual([]);
    const nope = await fetch(`http://127.0.0.1:${port(server)}/nope`, { method: 'POST' });
    expect(nope.status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${port(server)}/health`);
    expect(health.status).toBe(200);
  });

  it('holds a /permission request open and answers with the resolved decision', async () => {
    server = await startHookServer(0, {
      onPayload: () => {},
      onPermission: async (raw) => {
        expect((raw as { tool_name?: string }).tool_name).toBe('Bash');
        return '{"decision":"allow"}';
      },
    });
    const res = await fetch(`http://127.0.0.1:${port(server)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'Bash', cwd: '/p' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"decision":"allow"}');
  });

  it('defers (204, empty) when onPermission resolves undefined', async () => {
    server = await startHookServer(0, { onPayload: () => {}, onPermission: async () => undefined });
    const res = await fetch(`http://127.0.0.1:${port(server)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ cwd: '/p' }),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('POST /slot hands the parsed body to onSlot and returns its {status, body}', async () => {
    let received: unknown;
    server = await startHookServer(0, {
      onPayload: () => {},
      onSlot: async (raw) => {
        received = raw;
        return { status: 200, body: '{"ok":true}' };
      },
    });
    const res = await fetch(`http://127.0.0.1:${port(server)}/slot`, {
      method: 'POST',
      body: JSON.stringify({ coord: 'a8', kind: 'app', app: '/Applications/Telegram.app' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(received).toMatchObject({ coord: 'a8', kind: 'app' });
  });

  it('POST /slot 404s when onSlot is unwired (old build)', async () => {
    server = await startHookServer(0, { onPayload: () => {} });
    const res = await fetch(`http://127.0.0.1:${port(server)}/slot`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('POST /slot 400s a malformed body', async () => {
    server = await startHookServer(0, { onPayload: () => {}, onSlot: async () => ({ status: 200, body: '{}' }) });
    const res = await fetch(`http://127.0.0.1:${port(server)}/slot`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('CSRF guard: rejects any request carrying an Origin header (a browser cross-origin POST) with 403', async () => {
    const seen: unknown[] = [];
    server = await startHookServer(0, { onPayload: (raw) => seen.push(raw) });
    const status = await rawPost(
      port(server),
      '/hook',
      { origin: 'https://evil.example', 'content-type': 'text/plain' },
      JSON.stringify({ hook_event_name: 'Stop', cwd: '/p', session_id: 's' }),
    );
    expect(status).toBe(403);
    expect(seen).toEqual([]); // never reached the handler
  });

  it('bounds how many sockets a local client can hold and how long it may take to send a request', async () => {
    server = await startHookServer(0, { onPayload: () => {} });
    expect(server.maxConnections).toBe(128);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(30_000);
    // Node only checks those timeouts on this sweep (30 s by default), which would let them fire up to 30 s late.
    const { connectionsCheckingInterval } = server as Server & { connectionsCheckingInterval: number };
    expect(connectionsCheckingInterval).toBeLessThanOrEqual(1_000);
  });

  it('logs the first connection dropped over the socket cap, not every one', async () => {
    const logged: string[] = [];
    server = await startHookServer(0, { onPayload: () => {}, onError: (endpoint) => void logged.push(endpoint) });
    let drops = 0;
    server.on('drop', () => drops++);
    const sockets: Socket[] = [];
    const open = (s: Server): Promise<void> =>
      new Promise((resolve) => {
        const socket = connect(port(s), '127.0.0.1', () => resolve());
        socket.on('error', () => {}); // the dropped ones are reset, which is the point
        sockets.push(socket);
      });
    try {
      for (let i = 0; i < 130; i++) await open(server);
      await vi.waitFor(() => expect(drops).toBe(2));
      expect(logged).toEqual(['listener']);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  // The listener answers hook events, permission decisions and live board edits, so an unauthorized
  // caller must not reach ANY of them. /health is deliberately exempt: the npm installer polls it to
  // confirm the new build is up, before a token can possibly have been exchanged.
  describe('token gate', () => {
    const gated = { onPayload: () => {}, authorize: (h: Record<string, unknown>) => h['x-jetstream-token'] === 'secret' };

    it('401s every state-changing endpoint without the token', async () => {
      const seen: unknown[] = [];
      server = await startHookServer(0, {
        ...gated,
        onPayload: (raw) => seen.push(raw),
        onPermission: async () => '{"decision":"allow"}',
        onSlot: async () => ({ status: 200, body: '{}' }),
      });
      for (const path of ['/hook', '/permission', '/slot']) {
        const res = await fetch(`http://127.0.0.1:${port(server)}${path}`, { method: 'POST', body: '{}' });
        expect(res.status, path).toBe(401);
      }
      expect(seen).toEqual([]); // no handler ran
    });

    it('answers a signed /permission request with a signed decision, and never needs the token header', async () => {
      const seen: unknown[] = [];
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onPermission: async (raw) => {
          seen.push(raw);
          return '{"decision":"allow"}';
        },
      });
      const body = '{"tool_name":"Bash"}';
      const url = `http://127.0.0.1:${port(server)}/permission`;
      const nonce = nonceAt();
      const ok = await fetch(url, { method: 'POST', headers: signed('req', body, nonce), body });
      expect(ok.status).toBe(200);
      const answer = await ok.text();
      expect(ok.headers.get(MAC_HEADER)).toBe(permissionMac('secret', 'res', nonce, answer));
      expect(seen).toHaveLength(1);
      // A MAC made with another key, or over another body, is refused before the deck sees it.
      const wrongKey = await fetch(url, { method: 'POST', headers: signed('req', body, nonceAt(), 'guess'), body });
      expect(wrongKey.status).toBe(401);
      const otherBody = await fetch(url, { method: 'POST', headers: signed('req', body), body: '{"tool_name":"Edit"}' });
      expect(otherBody.status).toBe(401);
      expect(seen).toHaveLength(1);
    });

    it('refuses a signed /permission request when the plugin holds no token', async () => {
      let calls = 0;
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => undefined,
        onPermission: async () => {
          calls++;
          return '{"decision":"allow"}';
        },
      });
      const body = '{"tool_name":"Bash"}';
      const res = await fetch(`http://127.0.0.1:${port(server)}/permission`, {
        method: 'POST',
        headers: signed('req', body),
        body,
      });
      expect(res.status).toBe(401);
      expect(calls).toBe(0);
    });

    it('still takes a 4.1.0-format request once, and refuses a replayed, stale or unstamped one', async () => {
      let calls = 0;
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onPermission: async () => {
          calls++;
          return '{"decision":"deny"}';
        },
      });
      const body = '{"tool_name":"Bash"}';
      const url = `http://127.0.0.1:${port(server)}/permission`;
      const headers = signed('req', body);
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);
      const stale = signed('req', body, nonceAt(Date.now() - 3 * 60_000));
      expect((await fetch(url, { method: 'POST', headers: stale, body })).status).toBe(401);
      const unstamped = signed('req', body, randomBytes(16).toString('hex'));
      expect((await fetch(url, { method: 'POST', headers: unstamped, body })).status).toBe(401);
      // A v2 MAC is never read as a 4.1.0 one, so dropping the challenge header does not get a v2 request in.
      const { [CHALLENGE_HEADER]: _dropped, ...stripped } = signedV2('req', body, await challengeFrom(server));
      expect((await fetch(url, { method: 'POST', headers: stripped, body })).status).toBe(401);
      expect(calls).toBe(1);
    });

    it('still takes a 4.1.0-format /slot edit once without the token header, and refuses a forged or replayed one', async () => {
      const seen: unknown[] = [];
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onSlot: async (raw) => {
          seen.push(raw);
          return { status: 200, body: '{}' };
        },
      });
      const body = '{"coord":"a1","kind":"empty"}';
      const url = `http://127.0.0.1:${port(server)}/slot`;
      const nonce = nonceAt();
      // A forged MAC must not use up its nonce, or junk requests could fill the memory and lock out real edits.
      expect((await fetch(url, { method: 'POST', headers: signed('slot', body, nonce, 'guess'), body })).status).toBe(401);
      const headers = signed('slot', body, nonce);
      const first = await fetch(url, { method: 'POST', headers, body });
      expect(first.status).toBe(200);
      expect(first.headers.get(MAC_HEADER)).toBeNull(); // a 4.1.0 CLI reads no answer MAC
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);
      // A /permission request MAC is not a /slot MAC, so one cannot be replayed as the other.
      expect((await fetch(url, { method: 'POST', headers: signed('req', body), body })).status).toBe(401);
      expect(seen).toEqual([{ coord: 'a1', kind: 'empty' }]);
    });

    it('the real permission hook gets a signed deck answer over HTTP for a multi-byte request', async () => {
      const seen: unknown[] = [];
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onPermission: async (raw) => {
          seen.push(raw);
          return permissionDecisionJson('allow');
        },
      });
      const prompt = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo "héllo 🚀 ✓"' } };
      const out = await runHook(port(server), prompt);
      expect(seen).toEqual([prompt]);
      expect(out).toBe(permissionDecisionJson('allow'));
    });

    it('refuses a request a port squatter captured from the real permission hook', async () => {
      // The squatter answers /challenge with one it made up, then keeps the signed request it gets.
      const captured: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
      const connections = new Set<number | undefined>();
      const issued = randomBytes(32).toString('hex');
      const squatter = createServer((req, res) => {
        connections.add(req.socket.remotePort);
        if (req.url === '/challenge') {
          res.writeHead(200);
          res.end(issued);
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => {
          captured.push({ headers: req.headers, body });
          res.writeHead(204);
          res.end();
        });
      });
      await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
      try {
        expect(await runHook(port(squatter), { session_id: 's', tool_name: 'Bash' })).toBe('');
        // The signed POST opened its own connection instead of riding the one that fetched the challenge.
        expect(connections.size).toBe(2);
      } finally {
        squatter.close();
      }
      let calls = 0;
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onPermission: async () => {
          calls++;
          return permissionDecisionJson('allow');
        },
      });
      const { headers, body } = captured[0] ?? { headers: {}, body: '' };
      // The hook signed over the squatter's challenge, the only kind of request it may send.
      expect(headers[CHALLENGE_HEADER]).toBe(issued);
      // Replay exactly what was captured: a header the hook left out must stay out.
      const replay: Record<string, string> = { 'content-type': 'application/json' };
      for (const name of [CHALLENGE_HEADER, NONCE_HEADER, MAC_HEADER]) {
        const value = headers[name];
        if (typeof value === 'string') replay[name] = value;
      }
      expect(await rawPost(port(server), '/permission', replay, body)).toBe(401);
      expect(calls).toBe(0);
    });

    it('issues single-use challenges, and refuses one it never issued or issued over 60 s ago', async () => {
      let calls = 0;
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onPermission: async () => {
          calls++;
          return '{"decision":"allow"}';
        },
      });
      const issued = await fetch(`http://127.0.0.1:${port(server)}/challenge`);
      expect(issued.status).toBe(200);
      expect(issued.headers.get('cache-control')).toBe('no-store');
      const challenge = await issued.text();
      expect(challenge).toMatch(/^[0-9a-f]{64}$/);
      // Like every route, it is closed to a browser.
      expect(await rawGet(port(server), '/challenge', { origin: 'https://evil.example' })).toBe(403);
      const body = '{"tool_name":"Bash"}';
      const url = `http://127.0.0.1:${port(server)}/permission`;
      // A forged MAC must not use up the challenge, or junk requests could lock out the real one.
      const forged = signedV2('req', body, challenge, nonceAt(), 'guess');
      expect((await fetch(url, { method: 'POST', headers: forged, body })).status).toBe(401);
      const nonce = nonceAt();
      const headers = signedV2('req', body, challenge, nonce);
      const ok = await fetch(url, { method: 'POST', headers, body });
      expect(ok.status).toBe(200);
      expect(ok.headers.get(MAC_HEADER)).toBe(challengeMac('secret', 'res', challenge, nonce, await ok.text()));
      // Single use, whatever nonce comes with it.
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);
      expect((await fetch(url, { method: 'POST', headers: signedV2('req', body, challenge), body })).status).toBe(401);
      const unissued = signedV2('req', body, randomBytes(32).toString('hex'));
      expect((await fetch(url, { method: 'POST', headers: unissued, body })).status).toBe(401);
      // Challenges age by the process's monotonic clock, so fake that rather than the wall clock.
      vi.useFakeTimers({ toFake: ['performance'] });
      try {
        const old = await challengeFrom(server);
        vi.advanceTimersByTime(61_000);
        expect((await fetch(url, { method: 'POST', headers: signedV2('req', body, old), body })).status).toBe(401);
      } finally {
        vi.useRealTimers();
      }
      expect(calls).toBe(1);
    });

    it('still takes a signed request after a flood of /challenge requests between its GET and its POST', async () => {
      let calls = 0;
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onPermission: async () => {
          calls++;
          return '{"decision":"allow"}';
        },
      });
      const challenge = await challengeFrom(server);
      // Anyone local can ask for challenges without the token; none of them may push out the client's.
      for (let i = 0; i < 20; i++) await Promise.all(Array.from({ length: 50 }, () => challengeFrom(server as Server)));
      const body = '{"tool_name":"Bash"}';
      const url = `http://127.0.0.1:${port(server)}/permission`;
      expect((await fetch(url, { method: 'POST', headers: signedV2('req', body, challenge), body })).status).toBe(200);
      expect(calls).toBe(1);
    });

    it('signs every answer to a v2 /slot edit over its status and body', async () => {
      server = await startHookServer(0, {
        ...gated,
        permissionKey: () => 'secret',
        onSlot: async (raw) => {
          if ((raw as { coord?: unknown }).coord === 'boom') throw new Error('render timeout');
          return { status: 200, body: '{}' };
        },
      });
      const url = `http://127.0.0.1:${port(server)}/slot`;
      /** Send one v2 edit; resolves the status, the answer MAC and the MAC expected over what came back. */
      const send = async (body: string) => {
        const challenge = await challengeFrom(server as Server);
        const nonce = nonceAt();
        const res = await fetch(url, { method: 'POST', headers: signedV2('slot', body, challenge, nonce), body });
        const text = await res.text();
        const expected = challengeMac('secret', 'slot-res', challenge, nonce, `${res.status}\n${text}`);
        return { status: res.status, mac: res.headers.get(MAC_HEADER), expected, text };
      };
      const applied = await send('{"coord":"a1","kind":"empty"}');
      expect(applied.status).toBe(200);
      expect(applied.text).toBe('{}');
      expect(applied.mac).toBe(applied.expected);
      const notJson = await send('not json');
      expect(notJson.status).toBe(400);
      expect(notJson.mac).toBe(notJson.expected);
      const failed = await send('{"coord":"boom"}');
      expect(failed.status).toBe(500);
      expect(failed.mac).toBe(failed.expected);
    });

    it('serves the same endpoints with the token, and leaves /health open without it', async () => {
      const seen: unknown[] = [];
      server = await startHookServer(0, { ...gated, onPayload: (raw) => seen.push(raw) });
      const res = await fetch(`http://127.0.0.1:${port(server)}/hook`, {
        method: 'POST',
        headers: { 'x-jetstream-token': 'secret' },
        body: JSON.stringify({ hook_event_name: 'Stop', cwd: '/p', session_id: 's' }),
      });
      expect(res.status).toBe(204);
      expect(seen).toHaveLength(1);
      expect((await fetch(`http://127.0.0.1:${port(server)}/health`)).status).toBe(200);
    });

    it('still takes the token header on /slot from a CLI older than signing', async () => {
      server = await startHookServer(0, { ...gated, onSlot: async () => ({ status: 200, body: '{}' }) });
      const res = await fetch(`http://127.0.0.1:${port(server)}/slot`, {
        method: 'POST',
        headers: { 'x-jetstream-token': 'secret' },
        body: '{"coord":"a1","kind":"empty"}',
      });
      expect(res.status).toBe(200);
    });

    it('answers 401 as a real HTTP response, not a socket reset', async () => {
      // A hook that gets ECONNRESET cannot tell "rejected" from "plugin not running", so the
      // rejection must arrive as a status the client can actually read.
      server = await startHookServer(0, gated);
      const status = await rawPost(port(server), '/hook', { 'content-type': 'application/json' }, '{"a":1}');
      expect(status).toBe(401);
    });
  });
});

describe('nonceMemory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a new nonce once 1024 are held, and takes them again once that window has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-08T12:00:00Z');
    vi.setSystemTime(t0);
    const claim = nonceMemory();
    for (let i = 0; i < 1024; i++) expect(claim(nonceAt(t0))).toBe(true);
    // Full: refused, not made room for, since a forgotten nonce could be replayed.
    expect(claim(nonceAt(t0))).toBe(false);
    // Past the freshness window the old nonces are pruned, so a long-lived plugin keeps working.
    vi.setSystemTime(t0 + 2 * 60_000 + 1_000);
    expect(claim(nonceAt())).toBe(true);
  });
});

describe('challengeStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a challenge claimable however many are issued after it, and each one claims only once', () => {
    const store = challengeStore();
    const first = store.issue();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 1000; i++) store.issue();
    expect(store.claim(first)).toBe(true);
    expect(store.claim(first)).toBe(false);
  });

  it('refuses a challenge it did not issue, even in the right shape', () => {
    const store = challengeStore();
    const issued = store.issue();
    // The last character flipped breaks the MAC; another listener signs with another secret.
    const tampered = `${issued.slice(0, 63)}${issued.endsWith('0') ? '1' : '0'}`;
    expect(store.claim(tampered)).toBe(false);
    expect(store.claim(challengeStore().issue())).toBe(false);
    expect(store.claim(randomBytes(32).toString('hex'))).toBe(false);
    expect(store.claim('not a challenge')).toBe(false);
    expect(store.claim(issued)).toBe(true);
  });

  it('refuses a challenge issued over 60 s ago', () => {
    let t = 1_000;
    const store = challengeStore(() => t);
    const old = store.issue();
    const recent = store.issue();
    t += 60_000;
    expect(store.claim(recent)).toBe(true);
    t += 1;
    expect(store.claim(old)).toBe(false);
  });

  it('refuses a new claim once 1024 are used, and takes them again once those have expired', () => {
    let t = 1_000;
    const store = challengeStore(() => t);
    for (let i = 0; i < 1024; i++) expect(store.claim(store.issue())).toBe(true);
    // Full: refused, not made room for, since a forgotten challenge could be replayed.
    expect(store.claim(store.issue())).toBe(false);
    t += 61_000;
    expect(store.claim(store.issue())).toBe(true);
  });

  it('never reopens a claimed challenge when the wall clock steps forward and back', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-10-08T12:00:00Z');
    vi.setSystemTime(t0);
    const store = challengeStore();
    const claimed = store.issue();
    expect(store.claim(claimed)).toBe(true);
    vi.setSystemTime(t0 + 120_000);
    expect(store.claim(store.issue())).toBe(true);
    vi.setSystemTime(t0 + 1_000);
    expect(store.claim(claimed)).toBe(false);
  });
});
