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
  it('builds node-quoted absolute hook commands', () => {
    const cmds = hookCommands(BIN, false);
    expect(cmds.status).toBe(`"${process.execPath}" "/plugin/bin/status-hook.js"`);
    expect(cmds.permission).toContain('permission-hook.js');
    expect(cmds.usage).toContain('usage-hook.js');
    expect(cmds.toolDetail).toBe(false);
  });
});
