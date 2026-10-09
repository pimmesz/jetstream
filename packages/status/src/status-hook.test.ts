import { describe, it, expect, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initialState, parseHookPayload, reduce, type StatusState } from './index';
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
  it('stamps the fire time and the parent pid on the posted event, posts only the fields the plugin reads, and spools nothing once delivered', async () => {
    const { posted, spooled, deps } = await run(STOP, true);
    expect(posted.map((p) => JSON.parse(p))).toEqual([{ hook_event_name: 'Stop', session_id: 's', cwd: '/r', _pid: 42, _at: 1_000 }]);
    expect(spooled).toEqual([]);
    expect(deps.clearStopFlag).toHaveBeenCalledWith('Stop', 's');
  });

  it('spools a refused event with its fire time and pid, and only the fields the plugin reads', async () => {
    const { spooled } = await run(STOP, false);
    expect(spooled.map((p) => JSON.parse(p))).toEqual([
      { hook_event_name: 'Stop', session_id: 's', cwd: '/r', _pid: 42, _at: 1_000 },
    ]);
  });

  // The plugin reads only a JSON object's fields, so anything else would reach the untokened /hook raw.
  const PROMPT = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/r', prompt: 'private prompt' };
  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON cut short with the prompt in it', JSON.stringify(PROMPT).slice(0, -5)],
    ['a JSON array', JSON.stringify([PROMPT])],
    ['a JSON string', JSON.stringify('private prompt')],
  ])('posts and spools nothing for %s', async (_name, stdin) => {
    // Refused, so a raw post that fell through to the spool would show up too.
    const { posted, spooled } = await run(stdin, false);
    expect(posted).toEqual([]);
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
  /** A fake plugin that answers only once the whole body is in, and records what arrived where. */
  const recorder = async (): Promise<{ server: Server; received: Array<{ method?: string; url?: string; body: string }> }> => {
    const received: Array<{ method?: string; url?: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, received };
  };

  it('POSTs the body to /hook byte for byte, multi-byte text included', async () => {
    const { server, received } = await recorder();
    try {
      const body = JSON.stringify({ hook_event_name: 'Stop', cwd: '/p', session_id: 's', x: 'héllo' });
      expect(await postHook(body, portOf(server))).toBe(true);
      // A content-length counted in characters, not bytes, would cut this body short.
      expect(received).toEqual([{ method: 'POST', url: '/hook', body }]);
    } finally {
      await close(server);
    }
  });

  it('sends /hook only the fields the plugin reads, and the board reduces them to the same state', async () => {
    const { server, received } = await recorder();
    const events = [
      { hook_event_name: 'SessionStart', session_id: 's', cwd: '/r', source: 'resume', transcript_path: '/private/t.jsonl' },
      { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/r', prompt: 'private prompt' },
      // Compaction re-fires SessionStart mid-turn: only `source` keeps the key from reading idle.
      { hook_event_name: 'SessionStart', session_id: 's', cwd: '/r', source: 'compact', transcript_path: '/private/t.jsonl' },
      { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', tool_name: 'Bash', tool_input: { command: 'cat private' } },
      { hook_event_name: 'SubagentStart', session_id: 's', cwd: '/r', agent_id: 'ag' },
      { hook_event_name: 'Notification', session_id: 's', cwd: '/r', notification_type: 'idle_prompt', message: 'private' },
      // A non-empty list keeps the agent in flight, so its length must survive the projection.
      { hook_event_name: 'Stop', session_id: 's', cwd: '/r', background_tasks: [{ description: 'private' }], last_assistant_message: 'private' },
      // An empty list while the agent is in flight ends it.
      { hook_event_name: 'Stop', session_id: 's', cwd: '/r', background_tasks: [], last_assistant_message: 'private' },
    ];
    // One fire time per event, so agent stamps and the reducer's fire-order guard see a real sequence.
    const firedAt = (index: number): number => 1_000 + index * 1_000;
    try {
      for (const [index, event] of events.entries()) {
        await runStatusHook({
          readStdin: async () => JSON.stringify(event),
          post: (body) => postHook(body, portOf(server)),
          appendSpool: () => {},
          clearStopFlag: () => {},
          now: () => firedAt(index),
          ppid: 42,
        });
      }
    } finally {
      await close(server);
    }
    expect(received.map(({ url }) => url)).toEqual(events.map(() => '/hook'));
    expect(received.map(({ body }) => body).join('\n')).not.toContain('private');
    const posted = received.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
    const read = ['hook_event_name', 'session_id', 'cwd', 'notification_type', 'source', 'tool_name', 'agent_id', 'background_tasks', '_pid', '_at'];
    for (const payload of posted) expect(Object.keys(payload).filter((key) => !read.includes(key))).toEqual([]);
    // The state after EVERY event, not only the last: a later event overwrites a tool name or a status.
    const scan = (payloads: unknown[]): StatusState[] =>
      payloads.reduce<StatusState[]>((states, raw, index) => {
        const state = states.at(-1) ?? initialState();
        const event = parseHookPayload(raw, firedAt(index));
        return [...states, event ? reduce(state, event) : state];
      }, []);
    expect(scan(posted)).toEqual(scan(events.map((event, index) => ({ ...event, _pid: 42, _at: firedAt(index) }))));
  });

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

  /** `promise`, or 'still pending' once `ms` has passed, so a hang fails its test instead of timing it out. */
  function within<T>(ms: number, promise: Promise<T>): Promise<T | 'still pending'> {
    return Promise.race([promise, new Promise<'still pending'>((resolve) => setTimeout(() => resolve('still pending'), ms))]);
  }

  // The socket timeout only measures silence, so every dripped byte or 102 would restart it.
  it.each([
    [
      'an answer dripped one byte at a time',
      (res: ServerResponse) => {
        res.writeHead(200);
        return setInterval(() => res.write('a'), 50);
      },
    ],
    ['an endless 102 Processing', (res: ServerResponse) => setInterval(() => res.writeProcessing(), 50)],
  ])('ends %s by its deadline, as delivered', async (_name, drip) => {
    const server = createServer((req, res) => {
      req.resume();
      const timer = drip(res);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      expect(await within(2_000, postHook('{}', portOf(server), 300))).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});
