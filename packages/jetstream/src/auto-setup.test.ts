import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoWireHooks, WIRE_VERSION } from './auto-setup';
import { HOOK_EVENTS } from './hooks-install';
import type { InstallOptions, InstallResult } from './hooks-install';

const BIN = '/plugin/bin';
const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

const tmpDirs: string[] = [];
const makeMarkerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-autowire-'));
  tmpDirs.push(dir);
  return join(dir, 'jetstream', 'auto-wired');
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('autoWireHooks (first-launch onboarding)', () => {
  it('installs status + permission + usage hooks (never tool-detail) and logs on change', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    let seen: InstallOptions | undefined;
    const install = vi.fn(async (options: InstallOptions): Promise<InstallResult> => {
      seen = options;
      return {
        changed: true,
        settingsPath: '/home/u/.claude/settings.json',
        backupPath: '/home/u/.claude/settings.json.jetstream-bak',
        backupCreated: true,
      };
    });

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });

    expect(seen?.commands.toolDetail).toBe(false); // higher-overhead tool-detail stays opt-in
    expect(seen?.commands.status).toContain('/plugin/bin/status-hook.js');
    expect(seen?.commands.permission).toContain('/plugin/bin/permission-hook.js');
    // The usage statusline IS offered now — installHooks only sets it when the user has
    // none (no-clobber lives in mergeHooks, covered by hooks-install.test.ts).
    expect(seen?.commands.usage).toContain('/plugin/bin/usage-hook.js');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toContain('/home/u/.claude/settings.json');
    expect(logger.info.mock.calls[0]?.[0]).toContain('jetstream-bak'); // fresh backup surfaced
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('runs ONCE: writes the marker on success and skips entirely on the next launch', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    const install = vi.fn(
      async (): Promise<InstallResult> => ({ changed: true, settingsPath: '/s.json' }),
    );

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf8').trim()).toBe(String(WIRE_VERSION)); // the wire-schema version it recorded

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });
    // Same version → a user who later removes the hooks is not fought on every launch.
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('a current-version marker means no install call at all', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${WIRE_VERSION}\n`); // already wired for the current hook set
    const install = vi.fn(async (): Promise<InstallResult> => ({ changed: false, settingsPath: '' }));

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });

    expect(install).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a stale marker (old timestamp format) re-wires ONCE to deliver newly-added hooks', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '2026-07-16T00:00:00.000Z\n'); // pre-versioned marker from an older install
    const install = vi.fn(async (): Promise<InstallResult> => ({ changed: true, settingsPath: '/s.json' }));

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });
    expect(install).toHaveBeenCalledTimes(1); // the fix: an old marker no longer blocks new hooks
    expect(readFileSync(markerPath, 'utf8').trim()).toBe(String(WIRE_VERSION)); // stamped to the current wire version

    // …and now that it matches, a subsequent launch skips.
    await autoWireHooks({ binDir: BIN, logger, markerPath, install });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the hooks were already installed (no noise, marker still written)', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    const install = vi.fn(
      async (): Promise<InstallResult> => ({ changed: false, settingsPath: '/s.json' }),
    );

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(true);
  });

  it('does NOT claim a backup when this install did not create one (fresh machine)', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    const install = vi.fn(
      async (): Promise<InstallResult> => ({ changed: true, settingsPath: '/home/u/.claude/settings.json' }),
    );

    await autoWireHooks({ binDir: BIN, logger, markerPath, install });

    const message = logger.info.mock.calls[0]?.[0] as string;
    expect(message).toContain('/home/u/.claude/settings.json');
    expect(message).toContain('Restart');
    expect(message).not.toContain('backed up');
    expect(message).not.toContain('undefined');
  });

  it('never throws when the installer fails — warns, points at the manual path, and does NOT write the marker (retries next launch)', async () => {
    const logger = makeLogger();
    const markerPath = makeMarkerPath();
    const install = vi.fn(async (): Promise<InstallResult> => {
      throw new Error('settings.json is not valid JSON');
    });

    await expect(autoWireHooks({ binDir: BIN, logger, markerPath, install })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain('jetstream setup');
    expect(existsSync(markerPath)).toBe(false); // consent wasn't recorded for a failed wire
  });

  it('never throws even when the LOGGER itself throws', async () => {
    const markerPath = makeMarkerPath();
    const explosive = {
      info: vi.fn(() => {
        throw new Error('logger down');
      }),
      warn: vi.fn(() => {
        throw new Error('logger down');
      }),
    };
    const okInstall = vi.fn(
      async (): Promise<InstallResult> => ({ changed: true, settingsPath: '/s.json' }),
    );
    await expect(
      autoWireHooks({ binDir: BIN, logger: explosive, markerPath, install: okInstall }),
    ).resolves.toBeUndefined();
    expect(existsSync(markerPath)).toBe(true); // a broken logger doesn't block the wire

    const badInstall = vi.fn(async (): Promise<InstallResult> => {
      throw new Error('boom');
    });
    await expect(
      autoWireHooks({ binDir: BIN, logger: explosive, markerPath: makeMarkerPath(), install: badInstall }),
    ).resolves.toBeUndefined();
  });

  it('uses the real installHooks when none is injected (the production seam)', async () => {
    vi.resetModules();
    const installSpy = vi.fn(
      async (options: InstallOptions): Promise<InstallResult> => ({
        changed: false,
        settingsPath: `/s.json?${options.commands.toolDetail}`,
      }),
    );
    vi.doMock('./hooks-install', () => ({ installHooks: installSpy }));
    const { autoWireHooks: wired } = await import('./auto-setup');

    await wired({ binDir: BIN, logger: makeLogger(), markerPath: makeMarkerPath() });

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installSpy.mock.calls[0]?.[0].commands.toolDetail).toBe(false);
    vi.doUnmock('./hooks-install');
    vi.resetModules();
  });
});

// The marker means "this machine is already wired for hook set vN", so an install that ADDS a hook
// without bumping WIRE_VERSION delivers it to nobody — every existing install skips the re-wire and
// the new hook never reaches ~/.claude/settings.json. That is silent: the code is correct, the tests
// pass, and only a fresh install gets the feature. This snapshot forces the bump to be deliberate.
describe('WIRE_VERSION tracks the hook set', () => {
  it('was bumped for the current set of auto-wired events', () => {
    const WIRED_AT = {
      2: ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'],
      3: ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'],
      4: ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop'],
    } as const;
    const expected = WIRED_AT[WIRE_VERSION as keyof typeof WIRED_AT];
    expect(
      expected,
      `WIRE_VERSION is ${WIRE_VERSION} but this table has no entry for it — add one`,
    ).toBeDefined();
    expect(
      [...HOOK_EVENTS],
      'HOOK_EVENTS changed without bumping WIRE_VERSION — existing installs would never get the new hook',
    ).toEqual([...expected]);
  });
});
