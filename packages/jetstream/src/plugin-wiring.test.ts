import { EventEmitter } from 'node:events';
import { initialState, reduce, type HookEvent } from '@pimmesz/jetstream-status';
import { describe, it, expect, vi } from 'vitest';
import {
  bindWithRetry,
  coalesce,
  createHookGate,
  createTokenSource,
  flushOnExit,
  handleHookPayload,
  replaySpool,
} from './plugin-wiring';

describe('createTokenSource', () => {
  it('retries a failed mint at most once a minute, reports the failure once, and keeps the token once it exists', () => {
    let t = 0;
    let fail = true;
    const ensure = vi.fn(() => {
      if (fail) throw new Error('disk full');
      return 'tok';
    });
    const onFirstFailure = vi.fn();
    const token = createTokenSource(ensure, { now: () => t, onFirstFailure });
    expect(token()).toBeUndefined();
    t = 30_000;
    expect(token()).toBeUndefined(); // inside the retry window: not even attempted
    expect(ensure).toHaveBeenCalledTimes(1);
    t = 61_000;
    expect(token()).toBeUndefined(); // attempted again, still failing
    expect(onFirstFailure).toHaveBeenCalledTimes(1);
    fail = false;
    t = 122_000;
    expect(token()).toBe('tok');
    expect(token()).toBe('tok');
    expect(ensure).toHaveBeenCalledTimes(3);
  });
});

describe('bindWithRetry', () => {
  it('keeps retrying while the port is held, and binds once it frees up', async () => {
    let t = 0;
    let attempts = 0;
    const result = await bindWithRetry(
      async () => {
        if (++attempts < 4) throw new Error('EADDRINUSE');
      },
      { now: () => t, sleep: async (ms) => void (t += ms), retryMs: 1_000, maxWaitMs: 90_000 },
    );
    expect(result).toEqual({ bound: true });
    expect(attempts).toBe(4);
  });

  it('gives up after the deadline and returns the last error', async () => {
    let t = 0;
    const result = await bindWithRetry(async () => Promise.reject(new Error('EADDRINUSE')), {
      now: () => t,
      sleep: async (ms) => void (t += ms),
      retryMs: 1_000,
      maxWaitMs: 3_000,
    });
    expect(result).toMatchObject({ bound: false });
    expect(t).toBe(3_000);
  });
});

describe('coalesce', () => {
  it('runs once for a burst of calls, and again for the next burst', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const schedule = coalesce(fn, 100);
      schedule();
      schedule();
      schedule();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
      schedule();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('handleHookPayload', () => {
  const deps = () => ({ now: () => 5, notePid: vi.fn(), forgetSession: vi.fn(), dispatch: vi.fn() });

  it('notes the pid, forgets an ended session, and dispatches the event', () => {
    const d = deps();
    handleHookPayload({ hook_event_name: 'SessionEnd', cwd: '/p', session_id: 's', _pid: 42 }, d);
    expect(d.notePid).toHaveBeenCalledWith('s', 42, '/p');
    expect(d.forgetSession).toHaveBeenCalledWith('s');
    expect(d.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: 'SessionEnd', sessionId: 's', at: 5 }));
  });

  it('ignores a payload that is not a hook event, and only forgets on SessionEnd', () => {
    const d = deps();
    handleHookPayload({ nope: true }, d);
    handleHookPayload({ hook_event_name: 'Stop', cwd: '/p', session_id: 's', _pid: 'x' }, d);
    expect(d.notePid).not.toHaveBeenCalled();
    expect(d.forgetSession).not.toHaveBeenCalled();
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('replaySpool', () => {
  const NOW = 10_000_000;
  /** Fake board deps: `newest` is the fire time the board already holds per session. */
  const deps = (newest: Record<string, number> = {}) => ({
    now: () => NOW,
    notePid: vi.fn(),
    forgetSession: vi.fn(),
    dispatch: vi.fn(),
    firedAt: (sessionId: string) => newest[sessionId],
    onError: vi.fn(),
  });
  const ev = (hook_event_name: string, _at: number, extra: Record<string, unknown> = {}) => ({
    hook_event_name,
    session_id: 's',
    cwd: '/p',
    _at,
    ...extra,
  });
  const replayed = (d: ReturnType<typeof deps>) => d.dispatch.mock.calls.map(([e]) => (e as { event: string }).event);

  it('skips an event older than the newest one the board holds, a stale SessionEnd included', () => {
    const d = deps({ s: NOW - 5 * 60_000 });
    replaySpool([ev('Stop', NOW - 30 * 60_000), ev('SessionEnd', NOW - 6 * 60_000)], d);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.forgetSession).not.toHaveBeenCalled();
  });

  it('applies an event that fired in the same millisecond as the newest one, or later', () => {
    const d = deps({ s: NOW - 1_000 });
    replaySpool([ev('Stop', NOW - 1_000), ev('Notification', NOW - 500)], d);
    expect(replayed(d)).toEqual(['Stop', 'Notification']);
  });

  it('replays subagent events whatever their order against the parent', () => {
    const d = deps({ s: NOW - 1_000 });
    const agent = { agent_id: 'a' };
    replaySpool([ev('SubagentStart', NOW - 9_000, agent), ev('SubagentStop', NOW - 8_000, agent)], d);
    expect(replayed(d)).toEqual(['SubagentStart', 'SubagentStop']);
  });

  it('applies each event as of when it fired, never later than now', () => {
    const d = deps();
    replaySpool([ev('UserPromptSubmit', NOW - 30 * 60_000), ev('Stop', NOW + 60_000)], d);
    const times = d.dispatch.mock.calls.map(([e]) => [(e as HookEvent).at, (e as HookEvent).firedAt]);
    expect(times).toEqual([
      [NOW - 30 * 60_000, NOW - 30 * 60_000],
      [NOW, NOW + 60_000], // a stamp from the future is applied now
    ]);
  });

  it('keeps replaying after one payload throws, and reports the error', () => {
    const d = deps();
    const boom = new Error('board bug');
    d.dispatch.mockImplementationOnce(() => {
      throw boom;
    });
    replaySpool([ev('Stop', NOW - 2_000), null, ev('Notification', NOW - 1_000)], d);
    expect(replayed(d)).toEqual(['Stop', 'Notification']);
    expect(d.onError).toHaveBeenCalledWith(boom);
  });
});

describe('createHookGate', () => {
  it('holds payloads until opened, then applies them in arrival order as of when each arrived', () => {
    let t = 1;
    const apply = vi.fn();
    const gate = createHookGate(apply, { now: () => t });
    gate.accept('a');
    t = 2;
    gate.accept('b');
    expect(apply).not.toHaveBeenCalled();
    t = 9;
    gate.open();
    gate.accept('c');
    expect(apply.mock.calls).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 9],
    ]);
  });

  it('holds at most 8 MiB of bodies, so a flood of large ones during the restore cannot grow it', () => {
    const apply = vi.fn();
    const gate = createHookGate(apply);
    const big = { pad: 'x'.repeat(256 * 1024) };
    for (let i = 0; i < 40; i++) gate.accept(big);
    gate.open();
    expect(apply.mock.calls.length).toBeLessThan(40);
    expect(apply.mock.calls.length).toBeGreaterThanOrEqual(31);
  });

  it('counts bytes, not characters, so multibyte bodies cannot pass the cap', () => {
    const apply = vi.fn();
    const gate = createHookGate(apply);
    const wide = { text: '漢'.repeat(87_000) }; // about 255 KB as UTF-8, a third of that in characters
    for (let i = 0; i < 96; i++) gate.accept(wide);
    gate.open();
    expect(apply.mock.calls.length).toBeLessThanOrEqual(33);
  });

  it('drops a body it cannot measure instead of throwing, and keeps the rest', () => {
    const apply = vi.fn();
    const gate = createHookGate(apply);
    // Stands in for a body nested too deep to serialize: Node 24 throws on one, newer V8 does not.
    const unmeasurable = {
      toJSON: () => {
        throw new RangeError('Maximum call stack size exceeded');
      },
    };
    expect(() => gate.accept(unmeasurable)).not.toThrow();
    gate.accept('ok');
    gate.open();
    expect(apply.mock.calls).toEqual([['ok', expect.any(Number)]]);
  });

  it('keeps applying held payloads after one throws, and reports the error', () => {
    const boom = new Error('board bug');
    const apply = vi.fn((raw: unknown) => {
      if (raw === 'a') throw boom;
    });
    const onError = vi.fn();
    const gate = createHookGate(apply, { onError });
    gate.accept('a');
    gate.accept('b');
    gate.open();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe('restart ordering: the spool replay runs before the live events held during the restore', () => {
  const T = 10_000_000;
  const ev = (hook_event_name: string, _at: number, extra: Record<string, unknown> = {}) => ({
    hook_event_name,
    session_id: 's',
    cwd: '/p',
    _at,
    ...extra,
  });
  /** The real reducer behind the same steps plugin.ts takes: live events held, spool replayed, gate opened. */
  const restart = (spooled: unknown[], live: unknown[]) => {
    let state = initialState();
    const deps = {
      now: () => T,
      notePid: vi.fn(),
      forgetSession: vi.fn(),
      dispatch: (event: HookEvent) => {
        state = reduce(state, event);
      },
    };
    const gate = createHookGate((raw, at) => handleHookPayload(raw, { ...deps, now: () => at }), { now: () => T });
    for (const raw of live) gate.accept(raw);
    replaySpool(spooled, { ...deps, firedAt: (id) => state.sessions[id]?.firedAt, onError: vi.fn() });
    gate.open();
    return state.sessions.s;
  };

  it('a live SubagentStop cancels the spooled SubagentStart of the same agent', () => {
    const session = restart([ev('SubagentStart', T - 5_000, { agent_id: 'a' })], [ev('SubagentStop', T - 1_000, { agent_id: 'a' })]);
    expect(session?.inflight ?? []).toEqual([]);
  });

  it('a spooled SubagentStop with no background tasks does not clear an agent that started live', () => {
    const session = restart(
      [
        ev('SubagentStart', T - 9_000, { agent_id: 'a' }),
        ev('SubagentStop', T - 5_000, { agent_id: 'a', background_tasks: [] }),
      ],
      [ev('SubagentStart', T - 1_000, { agent_id: 'b' })],
    );
    expect(session?.inflight?.map((agent) => agent.id)).toEqual(['b']);
  });

  it('a SubagentStop a later poll replays does not clear an agent that started live in the meantime', () => {
    let state = initialState();
    let clock = T - 9_000;
    const deps = {
      now: () => clock,
      notePid: vi.fn(),
      forgetSession: vi.fn(),
      dispatch: (event: HookEvent) => {
        state = reduce(state, event);
      },
    };
    const gate = createHookGate((raw, at) => handleHookPayload(raw, { ...deps, now: () => at }), { now: () => clock });
    gate.open(); // the startup drain found nothing
    gate.accept(ev('SubagentStart', clock, { agent_id: 'a' }));
    clock = T - 1_000;
    gate.accept(ev('SubagentStart', clock, { agent_id: 'b' }));
    // a's Stop was refused before the bind and appended after the startup drain; the next poll replays it.
    clock = T;
    const late = ev('SubagentStop', T - 5_000, { agent_id: 'a', background_tasks: [] });
    replaySpool([late], { ...deps, firedAt: (id) => state.sessions[id]?.firedAt, onError: vi.fn() });
    expect(state.sessions.s?.inflight?.map((agent) => agent.id)).toEqual(['b']);
  });

  it('a live SubagentStart that arrived late still counts as started before a replayed empty list', () => {
    let state = initialState();
    let clock = T - 1_000;
    const deps = {
      now: () => clock,
      notePid: vi.fn(),
      forgetSession: vi.fn(),
      dispatch: (event: HookEvent) => {
        state = reduce(state, event);
      },
    };
    const gate = createHookGate((raw, at) => handleHookPayload(raw, { ...deps, now: () => at }), { now: () => clock });
    gate.open();
    // b's Start fired at T - 8 s but its POST only arrived at T - 1 s.
    gate.accept(ev('SubagentStart', T - 8_000, { agent_id: 'b' }));
    clock = T;
    // The parent's empty list fired at T - 5 s, after b started, and a later poll replays it.
    replaySpool([ev('Stop', T - 5_000, { background_tasks: [] })], { ...deps, firedAt: (id) => state.sessions[id]?.firedAt, onError: vi.fn() });
    expect(state.sessions.s?.inflight).toBeUndefined();
  });
});

describe('flushOnExit', () => {
  it('flushes when the process exits on its own (a closed socket), and a signal exits through the same path', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const flush = vi.fn();
    flushOnExit(flush, proc);
    proc.emit('SIGTERM');
    expect(proc.exit).toHaveBeenCalledWith(0);
    expect(flush).not.toHaveBeenCalled(); // the signal only exits; the 'exit' event is what flushes
    proc.emit('exit', 0);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
