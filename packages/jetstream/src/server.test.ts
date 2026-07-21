import { describe, it, expect, afterEach } from 'vitest';
import { request, type Server } from 'node:http';
import { startHookServer } from './server';

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

    it('answers 401 as a real HTTP response, not a socket reset', async () => {
      // A hook that gets ECONNRESET cannot tell "rejected" from "plugin not running", so the
      // rejection must arrive as a status the client can actually read.
      server = await startHookServer(0, gated);
      const status = await rawPost(port(server), '/hook', { 'content-type': 'application/json' }, '{"a":1}');
      expect(status).toBe(401);
    });
  });
});
