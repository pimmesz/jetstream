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

  it('resolves the held request with the Approve decision JSON on settle', async () => {
    const p = new Permissions();
    const pending = p.request(req());
    const id = p.head()?.id;
    expect(p.head()?.summary).toBe('Bash: npm test');
    expect(p.settle(id, 'allow')).toBe(true);
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

  it('settle acts on the id it was given (FIFO), and refuses a stale id after a head-swap', async () => {
    const p = new Permissions();
    const first = p.request(req({ tool_input: { command: 'a' } }));
    p.request(req({ tool_input: { command: 'b' } }));
    expect(p.count()).toBe(2);
    const firstId = p.head()?.id;
    expect(p.settle(firstId, 'deny')).toBe(true);
    expect(JSON.parse((await first) as string).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(p.head()?.summary).toBe('Bash: b'); // b promoted to head
    // The key still shows 'a' (already settled). Pressing it must NOT settle b — the user never
    // reviewed b — so a stale id returns false and leaves b untouched.
    expect(p.settle(firstId, 'allow')).toBe(false);
    expect(p.count()).toBe(1);
    const secondId = p.head()?.id;
    expect(p.settle(secondId, 'allow')).toBe(true);
    expect(p.settle(secondId, 'allow')).toBe(false); // empty queue → false
    expect(p.settle(undefined, 'allow')).toBe(false); // an undefined id never settles
  });

  describe('Always-Allow (session-scoped, memory-only)', () => {
    it('auto-approves a later same-session same-tool request with no keypress once armed', async () => {
      const p = new Permissions();
      const first = p.request(req()); // s1 / Bash
      expect(p.allowAlways(p.head()?.id)).toBe(true); // long-press APPROVE arms + settles
      expect(JSON.parse((await first) as string).hookSpecificOutput.decision.behavior).toBe('allow');
      expect(p.count()).toBe(0);
      expect(p.allowRuleCount()).toBe(1);

      // A NEW same-session same-tool request never queues — it auto-allows immediately, even a
      // scarier command: the grant was scoped to the tool, which is the deliberate relaxation.
      const auto = await p.request(req({ tool_input: { command: 'rm -rf x' } }));
      expect(JSON.parse(auto as string).hookSpecificOutput.decision.behavior).toBe('allow');
      expect(p.count()).toBe(0); // never queued
    });

    it('scopes to the exact session AND tool — a different session or tool still queues', async () => {
      const p = new Permissions();
      const first = p.request(req()); // s1 / Bash
      p.allowAlways(p.head()?.id);
      await first;
      p.request(req({ session_id: 's2' })); // different session → queues
      expect(p.count()).toBe(1);
      p.request(req({ tool_name: 'Write' })); // same session, different tool → queues
      expect(p.count()).toBe(2);
    });

    it('never arms a rule for the empty-session fallback (no unscoped wildcard auto-allow)', () => {
      const p = new Permissions();
      p.request(req({ session_id: undefined })); // sessionId parses to ''
      expect(p.allowAlways(p.head()?.id)).toBe(true); // settles the head...
      expect(p.allowRuleCount()).toBe(0); // ...but arms nothing
    });

    it('refuses a stale id — never arms a request the user did not review', () => {
      const p = new Permissions();
      p.request(req({ tool_input: { command: 'a' } }));
      p.request(req({ tool_input: { command: 'b' } }));
      expect(p.allowAlways('perm-does-not-exist')).toBe(false);
      expect(p.allowRuleCount()).toBe(0);
    });

    it('forgetSession drops that session’s rules so a later request queues again (SessionEnd cleanup)', async () => {
      const p = new Permissions();
      const first = p.request(req());
      p.allowAlways(p.head()?.id);
      await first;
      expect(p.allowRuleCount()).toBe(1);
      p.forgetSession('s1');
      expect(p.allowRuleCount()).toBe(0);
      p.request(req()); // no longer auto-allowed → queues
      expect(p.count()).toBe(1);
    });

    it('forgetSession emits ONLY when it removed a rule (repaints the auto-allow face)', async () => {
      const p = new Permissions();
      const first = p.request(req());
      p.allowAlways(p.head()?.id);
      await first;
      let calls = 0;
      p.subscribe(() => calls++);
      p.forgetSession('other-session'); // nothing matched → no repaint
      expect(calls).toBe(0);
      p.forgetSession('s1'); // removed the rule → repaint so "auto-allow: N" updates
      expect(calls).toBe(1);
    });
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
