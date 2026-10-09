import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { BoardLayout } from './board-layout';
import { applyLayout } from './chat-apply';
import { runChatSetup } from './chat-setup';
import { run, hookCommands } from './cli';
import type { CheckResult, DoctorIO } from './doctor';
import { DECK_MODELS } from './profile';
import { writeInPlace } from './profile-store';

const BIN = '/plugin/bin';

// chat and init return before their first question, so their wiring is testable without a tty.
vi.mock('./chat-setup', async (orig) => ({
  ...(await orig<typeof import('./chat-setup')>()),
  runChatSetup: vi.fn(async () => 0),
}));
// The real applyLayout by default; a test swaps in one call to see what chat's onLayout hands it.
vi.mock('./chat-apply', async (orig) => {
  const actual = await orig<typeof import('./chat-apply')>();
  return { ...actual, applyLayout: vi.fn(actual.applyLayout) };
});
vi.mock('./init', async (orig) => ({
  ...(await orig<typeof import('./init')>()),
  runInit: vi.fn(async () => 0),
}));
// The real readline and writer, wrapped so a test can reach the chat's rl and stand in for one write.
vi.mock('node:readline/promises', async (orig) => {
  const actual = await orig<typeof import('node:readline/promises')>();
  return { ...actual, createInterface: vi.fn(actual.createInterface) };
});
vi.mock('./profile-store', async (orig) => {
  const actual = await orig<typeof import('./profile-store')>();
  return { ...actual, writeInPlace: vi.fn(actual.writeInPlace) };
});
// doctor runs its real checks over a fake IO: no npm request, no probe of whatever listens on the
// plugin port, no read of this machine's Claude config.
const doctorIO = vi.hoisted(
  (): DoctorIO => ({
    env: {},
    claudeOnPath: () => true,
    settingsRaw: () => undefined,
    projectsRaw: () => undefined,
    listenerAlive: async () => false,
    boardLayout: () => null,
    latestVersion: vi.fn(async () => null),
    listenerToken: () => ({ present: true, private: true, consistent: true }),
    declaredActions: () => [],
  }),
);
vi.mock('./doctor', async (orig) => {
  const actual = await orig<typeof import('./doctor')>();
  return { ...actual, runDoctor: vi.fn(async () => actual.runDoctor(doctorIO)) };
});

// HOME is a temp dir in every test: the verbs that record shell dirs write under ~/.jetstream.
let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jetstream-cli-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('cli dispatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('unknown command → usage on stderr + non-zero exit', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await run(['frobnicate'], BIN);
    expect(code).toBe(1);
    expect(err.mock.calls.join('\n')).toContain('Unknown command');
  });

  it('no command → non-zero exit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run([], BIN)).toBe(1);
  });

  it('--help → usage on stdout + zero exit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--help'], BIN)).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('Usage:');
  });

  it('--version → the plugin manifest version (unknown off-bundle) + zero exit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--version'], BIN)).toBe(0); // BIN is fake → no manifest → 'unknown'
    expect(log.mock.calls.join('\n')).toContain('Jetstream plugin unknown');
  });

  it('update → points at the npm CLI (the plugin cannot replace its own package)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['update'], BIN)).toBe(0);
    const printed = log.mock.calls.join('\n');
    expect(printed).toContain('@pimmesz/jetstream');
    // It must NOT hand out a bare `npm i -g`: a `@pimmesz:registry` line in .npmrc overrides a
    // plain --registry, and a stale mirror then reinstalls the same version while reporting
    // success — the exact failure `jetstream update` exists to prevent.
    expect(printed).toContain('--registry=https://registry.npmjs.org/');
    expect(printed).toContain('--@pimmesz:registry=https://registry.npmjs.org/');
    // …and force a fresh packument so npm's own cache can't reinstall the old version either.
    expect(printed).toContain('--prefer-online');
    expect(printed).not.toMatch(/npm i -g @pimmesz\/jetstream/);
  });

  it('install points at the npm CLI instead of failing as an unknown command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['install'], BIN)).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('npm i -g @pimmesz/jetstream');
    expect(log.mock.calls.join('\n')).toContain('jetstream install');
    expect(err).not.toHaveBeenCalled();
  });

  it('unknown hooks subcommand → non-zero exit (does not install)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['hooks', 'wat'], BIN)).toBe(1);
  });

  it('doctor --json prints every check as JSON and exits 0 even when checks warn (advisory)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(doctorIO.latestVersion).mockClear();
    expect(await run(['doctor', '--json'], BIN)).toBe(0);
    const results = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as CheckResult[];
    expect(results.find((r) => r.message.includes('plugin hook listener'))?.status).toBe('warn');
    expect(doctorIO.latestVersion).toHaveBeenCalledOnce(); // the npm probe hit the fake, not the registry
  });

  it('chat hands the chat a pending store backed by ~/.jetstream/chat-pending.json', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runChatSetup).mockClear();

    expect(await run(['chat'], BIN)).toBe(0);
    const deps = vi.mocked(runChatSetup).mock.lastCall?.[0];
    deps?.pending?.save({ profileDir: '/p/A.sdProfile' } as BoardLayout, new Map());

    // A memory-only store would leave the next chat blind to this chat's unsaved live edits.
    expect(existsSync(join(home, '.jetstream', 'chat-pending.json'))).toBe(true);
  });

  it("chat passes the plan's onConflict to applyLayout, so a 409 forgets the stored edit", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runChatSetup).mockClear();
    expect(await run(['chat'], BIN)).toBe(0);
    const onLayout = vi.mocked(runChatSetup).mock.lastCall?.[0].onLayout;
    vi.mocked(applyLayout).mockImplementationOnce(async (_placements, deps) => {
      deps.onConflict?.(['a1']);
      return 'declined';
    });
    const onConflict = vi.fn();

    await onLayout?.([], { deck: DECK_MODELS[2]!, board: null, onConflict });

    // Without it, a lost live edit stays stored and every retry at that key gets the same 409.
    expect(onConflict).toHaveBeenCalledWith(['a1']);
  });

  it('Ctrl-C during the in-place write closes readline, then raises a real SIGINT that calls the write off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runChatSetup).mockClear();
    vi.mocked(writeInPlace).mockClear();
    expect(await run(['chat'], BIN)).toBe(0);
    const onLayout = vi.mocked(runChatSetup).mock.lastCall?.[0].onLayout;
    const rl = vi.mocked(createInterface).mock.results.at(-1)?.value as Interface;
    const order: string[] = [];
    vi.spyOn(rl, 'close').mockImplementation(() => void order.push('close'));
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      order.push(`kill ${pid} ${signal}`);
      return true;
    });
    let listenersAfterQuietWrite = -1;
    vi.mocked(writeInPlace)
      .mockImplementationOnce(async () => ({ ok: true, backup: '/b', removed: [] }))
      .mockImplementationOnce(async () => {
        rl.emit('SIGINT'); // what readline does with a keyboard Ctrl-C while it holds the tty raw
        return { ok: false, reason: 'stopped by SIGINT before anything was written' };
      });
    vi.mocked(applyLayout).mockImplementationOnce(async (_placements, deps) => {
      await deps.writeInPlace?.('/p/A.sdProfile', [], undefined, () => []);
      listenersAfterQuietWrite = rl.listenerCount('SIGINT');
      await deps.writeInPlace?.('/p/A.sdProfile', [], undefined, () => []);
      return 'declined';
    });
    // The in-place writer is only wired on macOS.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    try {
      await onLayout?.([], { deck: DECK_MODELS[2]!, board: null, onConflict: vi.fn() });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    expect(writeInPlace).toHaveBeenCalledTimes(2);
    // Closing first hands the tty back to the shell before the re-sent SIGINT ends the process.
    expect(order).toEqual(['close', `kill ${process.pid} SIGINT`]);
    // Once a write is over, with or without a Ctrl-C, a Ctrl-C is readline's own again.
    expect(listenersAfterQuietWrite).toBe(0);
    expect(rl.listenerCount('SIGINT')).toBe(0);
  });
});

describe('cli records the shell dirs for the plugin', () => {
  let configDir = '';
  const recordPath = (): string => join(home, '.jetstream', 'shell-dirs.json');
  beforeEach(() => {
    // The hooks land here, never in the real ~/.claude.
    configDir = mkdtempSync(join(tmpdir(), 'jetstream-cli-config-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('CODEX_HOME', undefined);
    // setup creates projects.json, which then lands under the temp HOME's .config.
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(configDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32').each([
    ['hooks install', ['hooks', 'install']],
    ['setup', ['setup']],
    ['chat', ['chat']],
    ['init', ['init']],
  ])('%s from a shell with CLAUDE_CONFIG_DIR records it for the plugin', async (_verb, argv) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await run(argv, BIN)).toBe(0);

    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({ CLAUDE_CONFIG_DIR: configDir });
    expect(log.mock.calls.join('\n')).toContain(`CLAUDE_CONFIG_DIR=${configDir}`);
  });

  it.skipIf(process.platform === 'win32')('hooks wat and doctor do not record', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run(['hooks', 'wat'], BIN)).toBe(1);
    expect(await run(['doctor'], BIN)).toBe(0);

    expect(existsSync(recordPath())).toBe(false);
  });
});

describe('hookCommands', () => {
  it('builds guarded node-quoted absolute hook commands', () => {
    const cmds = hookCommands(BIN, false);
    // Missing-file guard (mid-rebuild bin must not crash the hook), then exec some node.
    // Paths are single-quoted so shell metacharacters in an install path stay inert.
    expect(cmds.status).toMatch(
      /^\[ -f '\/plugin\/bin\/status-hook\.js' \] \|\| exit 0; exec '[^']+' '\/plugin\/bin\/status-hook\.js'$/,
    );
    expect(cmds.permission).toContain('permission-hook.js');
    expect(cmds.usage).toContain('usage-hook.js');
    expect(cmds.stopGate).toContain('stop-gate.js');
    expect(cmds.toolDetail).toBe(false);
  });
});
