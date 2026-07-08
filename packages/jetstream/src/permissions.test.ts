import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Permissions } from './permissions';

const req = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  cwd: '/Users/me/proj',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  ...over,
});

describe('Permissions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves the held request with the Approve decision JSON on settleHead', async () => {
    const p = new Permissions();
    const pending = p.request(req());
    expect(p.head()?.summary).toBe('Bash: npm test');
    expect(p.settleHead('allow')).toBe(true);
    expect(JSON.parse((await pending) as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(p.count()).toBe(0);
  });

  it('resolves undefined (defer) after the timeout with no key press', async () => {
    const p = new Permissions();
    const pending = p.request(req(), 90_000);
    vi.advanceTimersByTime(90_000);
    expect(await pending).toBeUndefined();
    expect(p.count()).toBe(0);
  });

  it('defers immediately for an unroutable request (no cwd)', async () => {
    const p = new Permissions();
    expect(await p.request(req({ cwd: undefined }))).toBeUndefined();
  });

  it('defers once the pending cap is reached (no unbounded growth)', async () => {
    const p = new Permissions();
    for (let i = 0; i < 32; i += 1) p.request(req());
    expect(p.count()).toBe(32);
    expect(await p.request(req())).toBeUndefined(); // 33rd defers immediately
    expect(p.count()).toBe(32);
  });

  it('settleHead is FIFO and returns false when the queue is empty', async () => {
    const p = new Permissions();
    const first = p.request(req({ tool_input: { command: 'a' } }));
    p.request(req({ tool_input: { command: 'b' } }));
    expect(p.count()).toBe(2);
    p.settleHead('deny');
    expect(JSON.parse((await first) as string).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(p.head()?.summary).toBe('Bash: b');
    p.settleHead('allow');
    expect(p.settleHead('allow')).toBe(false);
  });

  it('projectsWithPending maps held requests to project ids (deck-answerable set)', () => {
    const projects = [
      { id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' },
      { id: 'proj', name: 'Proj', path: '/Users/me/proj' },
      { id: 'idle', name: 'Idle', path: '/Users/me/idle' }, // no pending → excluded
    ];
    const p = new Permissions();
    p.request(req({ cwd: '/Users/me/proj' }));
    p.request(req({ cwd: '/Users/me/falcon/src' })); // sub-dir still matches falcon
    p.request(req({ cwd: '/Users/me/unlisted' })); // matches no project → dropped
    expect(p.projectsWithPending(projects)).toEqual(new Set(['proj', 'falcon']));
  });
});
