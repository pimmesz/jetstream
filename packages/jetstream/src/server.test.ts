import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAC_HEADER, NONCE_HEADER, permissionDecisionJson, permissionMac } from '@pimmesz/jetstream-status';
import { nonceMemory, startHookServer } from './server';

/** Raw POST so we can set an `Origin` header — undici's `fetch` silently drops it (forbidden name). */
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

/** Headers for a request signed with `key` over `body`. */
const signed = (kind: 'req' | 'slot', body: string, nonce = nonceAt(), key = 'secret'): Record<string, string> => ({
  [NONCE_HEADER]: nonce,
  [MAC_HEADER]: permissionMac(key, kind, nonce, body),
});

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

    it('refuses a replayed, stale or unstamped signed request, so captured bytes cannot be sent again', async () => {
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
      expect(calls).toBe(1);
    });

    it('applies a signed /slot edit without the token header, and refuses a forged or replayed one', async () => {
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
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
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
      const config = mkdtempSync(join(tmpdir(), 'jetstream-hook-'));
      try {
        mkdirSync(join(config, 'jetstream'));
        writeFileSync(join(config, 'jetstream', 'listener-token'), 'secret');
        const prompt = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo "héllo 🚀 ✓"' } };
        const hook = createRequire(import.meta.url).resolve('@pimmesz/jetstream-status/dist/permission-hook.js');
        const child = spawn(process.execPath, [hook], {
          env: { PATH: process.env.PATH, HOME: config, XDG_CONFIG_HOME: config, JETSTREAM_PORT: String(port(server)) },
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        const exited = new Promise((resolve) => child.on('close', resolve));
        // Indented, so a server that MACs a re-serialised body instead of the bytes it got would fail.
        child.stdin.end(JSON.stringify(prompt, null, 2));
        await exited;
        expect(seen).toEqual([prompt]);
        expect(out).toBe(permissionDecisionJson('allow'));
      } finally {
        rmSync(config, { recursive: true, force: true });
      }
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
