import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAC_HEADER, NONCE_HEADER, permissionMac } from '@pimmesz/jetstream-status';
import { sendSlot } from './slot-client';
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
async function plugin(seen: unknown[]): Promise<Server> {
  const s = await startHookServer(0, {
    onPayload: () => {},
    authorize: (headers, endpoint) => isAuthorized(headers, TOKEN, undefined, endpoint),
    permissionKey: () => TOKEN,
    onSlot: async (raw) => {
      seen.push(raw);
      return { status: 200, body: '{}' };
    },
  });
  aimAt(s);
  return s;
}

describe('sendSlot', () => {
  it('signs the edit and never sends the token, so a process squatting the port cannot learn it', async () => {
    writeToken();
    const seen: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    aimAt(server);
    expect(await sendSlot({ coord: 'a1', kind: 'app', app: '/Applications/Café.app' })).toBe(200);
    const headers = seen[0]?.headers ?? {};
    expect(headers[TOKEN_HEADER]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(TOKEN);
    const nonce = String(headers[NONCE_HEADER]);
    expect(nonce).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(headers[MAC_HEADER]).toBe(permissionMac(TOKEN, 'slot', nonce, seen[0]?.body ?? ''));
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
});
