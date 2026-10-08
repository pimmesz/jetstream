import { describe, it, expect, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { postHook, runStatusHook, type StatusHookDeps } from './status-hook';

/** One hook run with `stdin` as its input; `isDelivered` is what the POST reports. */
async function run(
  stdin: string,
  isDelivered: boolean,
): Promise<{ posted: string[]; spooled: string[]; deps: StatusHookDeps }> {
  const posted: string[] = [];
  const spooled: string[] = [];
  const deps: StatusHookDeps = {
    readStdin: async () => stdin,
    post: async (body) => {
      posted.push(body);
      return isDelivered;
    },
    appendSpool: (body) => spooled.push(body),
    clearStopFlag: vi.fn(),
    now: () => 1_000,
    ppid: 42,
  };
  await runStatusHook(deps);
  return { posted, spooled, deps };
}

const STOP = JSON.stringify({
  hook_event_name: 'Stop',
  session_id: 's',
  cwd: '/r',
  last_assistant_message: 'private',
});

describe('runStatusHook', () => {
  it('stamps the fire time and the parent pid on the posted event, and spools nothing once delivered', async () => {
    const { posted, spooled, deps } = await run(STOP, true);
    expect(posted.map((p) => JSON.parse(p))).toEqual([{ ...JSON.parse(STOP), _pid: 42, _at: 1_000 }]);
    expect(spooled).toEqual([]);
    expect(deps.clearStopFlag).toHaveBeenCalledWith('Stop', 's');
  });

  it('spools a refused event with its fire time and pid, and only the fields the plugin reads', async () => {
    const { spooled } = await run(STOP, false);
    expect(spooled.map((p) => JSON.parse(p))).toEqual([
      { hook_event_name: 'Stop', session_id: 's', cwd: '/r', _pid: 42, _at: 1_000 },
    ]);
  });

  it('forwards a body that is not a JSON object unchanged, and never spools it', async () => {
    const { posted, spooled } = await run('not json', false);
    expect(posted).toEqual(['not json']);
    expect(spooled).toEqual([]);
  });
});

describe('postHook', () => {
  type OnRequest = (headers: IncomingHttpHeaders, respond: () => void, destroy: () => void) => void;
  const listen = async (onRequest: OnRequest): Promise<Server> => {
    const server = createServer((req, res) => {
      req.resume();
      onRequest(req.headers, () => res.end(), () => req.socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const portOf = (server: Server): number => (server.address() as AddressInfo).port;
  const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

  it('sends no token header, and reports a delivered event', async () => {
    let seen: IncomingHttpHeaders = {};
    const server = await listen((headers, respond) => {
      seen = headers;
      respond();
    });
    try {
      expect(await postHook('{}', portOf(server))).toBe(true);
      expect(Object.keys(seen).filter((h) => h.startsWith('x-'))).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it('reports only a refused connection as undelivered: a timeout or a reset may already have arrived', async () => {
    const closed = await listen(() => {});
    const refusedPort = portOf(closed);
    await close(closed);
    expect(await postHook('{}', refusedPort)).toBe(false);

    const silent = await listen(() => {}); // never answers
    const reset = await listen((_headers, _respond, destroy) => destroy());
    try {
      expect(await postHook('{}', portOf(silent), 50)).toBe(true);
      expect(await postHook('{}', portOf(reset))).toBe(true);
    } finally {
      silent.closeAllConnections();
      await Promise.all([close(silent), close(reset)]);
    }
  });
});
