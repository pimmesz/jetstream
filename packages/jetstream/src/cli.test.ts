import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { BoardLayout } from './board-layout';
import { applyLayout } from './chat-apply';
import { runChatSetup } from './chat-setup';
import { run, hookCommands } from './cli';
import { DECK_MODELS } from './profile';

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

  it('doctor is advisory — always exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['doctor'], BIN)).toBe(0);
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
