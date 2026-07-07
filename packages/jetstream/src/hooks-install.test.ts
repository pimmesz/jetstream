import { describe, it, expect } from 'vitest';
import { mergeHooks, HOOK_EVENTS } from './hooks-install';

const STATUS = '"/usr/local/bin/node" "/plugin/bin/status-hook.js"';
const PERMISSION = '"/usr/local/bin/node" "/plugin/bin/permission-hook.js"';
const USAGE = '"/usr/local/bin/node" "/plugin/bin/usage-hook.js"';

describe('mergeHooks', () => {
  it('adds every lifecycle event, the PermissionRequest hook, and the statusline', () => {
    const { next, changed } = mergeHooks({}, { status: STATUS, permission: PERMISSION, usage: USAGE });
    expect(changed).toBe(true);
    const hooks = next.hooks as Record<string, unknown[]>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toEqual([{ hooks: [{ type: 'command', command: STATUS }] }]);
    }
    expect(hooks.PermissionRequest).toEqual([{ hooks: [{ type: 'command', command: PERMISSION }] }]);
    expect(next.statusLine).toEqual({ type: 'command', command: USAGE });
  });

  it('is idempotent', () => {
    const first = mergeHooks({}, { status: STATUS, permission: PERMISSION, usage: USAGE });
    const second = mergeHooks(first.next, { status: STATUS, permission: PERMISSION, usage: USAGE });
    expect(second.changed).toBe(false);
    expect(second.next).toEqual(first.next);
  });

  it('preserves existing user hooks on the same events', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } };
    const { next } = mergeHooks(settings, { status: STATUS });
    const stop = (next.hooks as Record<string, unknown[]>).Stop;
    expect(stop).toHaveLength(2);
    expect(JSON.stringify(stop)).toContain('my-own-hook');
    expect(JSON.stringify(stop)).toContain('status-hook.js');
  });

  it('never clobbers an existing statusLine', () => {
    const settings = { statusLine: { type: 'command', command: 'afterburner statusline' } };
    const { next } = mergeHooks(settings, { status: STATUS, usage: USAGE });
    expect(next.statusLine).toEqual({ type: 'command', command: 'afterburner statusline' });
  });

  it('skips PermissionRequest when no permission command is given', () => {
    const { next } = mergeHooks({}, { status: STATUS });
    expect((next.hooks as Record<string, unknown>).PermissionRequest).toBeUndefined();
  });
});
