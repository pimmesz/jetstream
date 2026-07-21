import { describe, it, expect, vi, afterEach } from 'vitest';
import { run, hookCommands } from './cli';

const BIN = '/plugin/bin';

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
    expect(printed).not.toMatch(/npm i -g @pimmesz\/jetstream/);
  });

  it('unknown hooks subcommand → non-zero exit (does not install)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(['hooks', 'wat'], BIN)).toBe(1);
  });

  it('doctor is advisory — always exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['doctor'], BIN)).toBe(0);
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
    expect(cmds.toolDetail).toBe(false);
  });
});
