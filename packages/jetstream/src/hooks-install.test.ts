import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { installHooks, mergeHooks, HOOK_EVENTS } from './hooks-install';

// Realistic jetstream commands: node + a script under the gg.pim.jetstream.sdPlugin dir
// (the marker the same-script matcher requires so it can't hijack a user's own hook).
const PLUGIN = '/Applications/com.elgato.StreamDeck/Plugins/gg.pim.jetstream.sdPlugin/bin';
const STATUS = `"/usr/local/bin/node" "${PLUGIN}/status-hook.js"`;
const PERMISSION = `"/usr/local/bin/node" "${PLUGIN}/permission-hook.js"`;
const USAGE = `"/usr/local/bin/node" "${PLUGIN}/usage-hook.js"`;

describe('mergeHooks', () => {
  it('collapses same-script duplicates left by an old-format re-wire (rollback self-heal)', () => {
    // A v3 single-quoted entry plus a duplicate the OLD installer pushed after a rollback
    // (its scriptOf couldn't parse single quotes, so it appended a double-quoted twin).
    const current = `[ -f '${PLUGIN}/status-hook.js' ] || exit 0; exec '/opt/homebrew/bin/node' '${PLUGIN}/status-hook.js'`;
    const settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: current }] },
          { hooks: [{ type: 'command', command: STATUS }] }, // stale double-quoted duplicate
        ],
      },
    };
    const { next, changed } = mergeHooks(settings, { status: current });
    expect(changed).toBe(true);
    const stop = (next.hooks as Record<string, unknown>).Stop as Array<{ hooks: unknown[] }>;
    const all = stop.flatMap((e) => e.hooks) as Array<{ command: string }>;
    expect(all.filter((h) => h.command.includes('status-hook.js'))).toHaveLength(1); // one survivor
    expect(all[0]!.command).toBe(current); // and it is the current-format one
  });

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

  it('adds PreToolUse/PostToolUse only with toolDetail', () => {
    const on = mergeHooks({}, { status: STATUS, toolDetail: true }).next.hooks as Record<string, unknown>;
    expect(on.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: STATUS }] }]);
    expect(on.PostToolUse).toEqual([{ hooks: [{ type: 'command', command: STATUS }] }]);
    const off = mergeHooks({}, { status: STATUS }).next.hooks as Record<string, unknown>;
    expect(off.PreToolUse).toBeUndefined();
  });

  it('toolDetail:false never removes previously-installed tool-detail hooks and stays a no-op', () => {
    // The every-launch auto-wire passes toolDetail:false; a user who opted into
    // --tool-detail must not be downgraded (or rewritten) by it.
    const withDetail = mergeHooks({}, { status: STATUS, toolDetail: true }).next;
    const second = mergeHooks(withDetail, { status: STATUS, toolDetail: false });
    expect(second.changed).toBe(false);
    const hooks = second.next.hooks as Record<string, unknown>;
    expect(hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: STATUS }] }]);
    expect(hooks.PostToolUse).toEqual([{ hooks: [{ type: 'command', command: STATUS }] }]);
  });

  it('a runtime/path change REPLACES the same-script hook instead of duplicating it', () => {
    // Terminal installs and the plugin's bundled Node have different execPaths; matching
    // on the exact command string used to add a second hook per event (double processes,
    // and a doubled BLOCKING PermissionRequest hook). Identity is the script now.
    const terminal = mergeHooks(
      {},
      { status: STATUS, permission: PERMISSION, usage: USAGE },
    ).next;
    // A different node runtime AND a different plugin location (dev-link vs installed) —
    // but both still under gg.pim.jetstream.sdPlugin, so it's recognized as ours.
    const other = '/Users/dev/repo/packages/jetstream/gg.pim.jetstream.sdPlugin/bin';
    const bundled = {
      status: `"/Applications/Elgato Stream Deck.app/node" "${other}/status-hook.js"`,
      permission: `"/Applications/Elgato Stream Deck.app/node" "${other}/permission-hook.js"`,
      usage: `"/Applications/Elgato Stream Deck.app/node" "${other}/usage-hook.js"`,
    };
    const { next, changed } = mergeHooks(terminal, bundled);
    expect(changed).toBe(true);
    const hooks = next.hooks as Record<string, unknown[]>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toEqual([{ hooks: [{ type: 'command', command: bundled.status }] }]);
    }
    expect(hooks.PermissionRequest).toEqual([
      { hooks: [{ type: 'command', command: bundled.permission }] },
    ]);
    // The statusline is OURS (usage-hook.js) → refreshed, not duplicated or abandoned.
    expect(next.statusLine).toEqual({ type: 'command', command: bundled.usage });
    // And a re-merge with the same commands settles.
    expect(mergeHooks(next, bundled).changed).toBe(false);
  });

  it("does NOT hijack a user's own same-basename hook that isn't ours", () => {
    // A user hook that happens to run a file called status-hook.js but is NOT under the
    // plugin dir must be left alone; ours is added ALONGSIDE, not swapped in.
    const foreign = '"/usr/local/bin/node" "/Users/me/scripts/status-hook.js"';
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } };
    const { next, changed } = mergeHooks(settings, { status: STATUS });
    expect(changed).toBe(true);
    const stop = (next.hooks as Record<string, unknown[]>).Stop;
    expect(stop).toHaveLength(2); // theirs preserved, ours added
    expect(JSON.stringify(stop)).toContain('/Users/me/scripts/status-hook.js');
    expect(JSON.stringify(stop)).toContain('gg.pim.jetstream');
  });

  it('a foreign statusLine is never rewritten, even when it differs from ours', () => {
    const settings = { statusLine: { type: 'command', command: 'afterburner statusline' } };
    const { next } = mergeHooks(settings, { status: STATUS, usage: USAGE });
    expect(next.statusLine).toEqual({ type: 'command', command: 'afterburner statusline' });
  });
});

describe('installHooks read failures', () => {
  it('an existing-but-unreadable settings path rejects instead of being silently replaced', async () => {
    // A directory at the settings path yields EISDIR — a non-ENOENT read failure must
    // throw (destroying config we merely could not read is never acceptable).
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-hooks-'));
    try {
      await expect(
        installHooks({ settingsPath: dir, commands: { status: STATUS } }),
      ).rejects.toThrow(/could not read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing file starts empty and reports the write with backupCreated undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-hooks-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      const result = await installHooks({ settingsPath, commands: { status: STATUS } });
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBeUndefined(); // nothing existed to back up
      expect(result.backupCreated).toBeUndefined();
      // Second run: nothing to do.
      const again = await installHooks({ settingsPath, commands: { status: STATUS } });
      expect(again.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backupCreated is true only for the install that made the backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-hooks-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      // Seed a pre-existing settings file so a backup is warranted.
      await installHooks({ settingsPath, commands: { status: '"n" "/x/other-tool.js"' } });
      const first = await installHooks({ settingsPath, commands: { status: STATUS } });
      expect(first.backupCreated).toBe(true);
      const second = await installHooks({ settingsPath, commands: { status: PERMISSION } });
      expect(second.changed).toBe(true); // a different script → a new hook
      expect(second.backupCreated).toBe(false); // pristine backup already exists
      expect(second.backupPath).toBe(`${settingsPath}.jetstream-bak`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
