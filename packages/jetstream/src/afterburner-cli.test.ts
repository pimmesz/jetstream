import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { augmentedPath, resolveAfterburner, runAfterburner } from './afterburner-cli';

// Mock only the two IO builtins this module reaches for; keep os/path real so every
// expected path in these assertions is computed with the exact join/delimiter the source uses.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

// The 4 global-install dirs augmentedPath appends, in order.
const EXTRA_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.npm-global', 'bin'),
];

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

// execFile is overloaded; drive its node-style callback from a plain impl and cast past the types.
const onExec = (fn: (cb: (e: Error | null, stdout: string) => void) => void) =>
  vi.mocked(execFile).mockImplementation(((_f: string, _a: unknown, _o: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    fn((e, so) => cb(e, so, ''));
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.mocked(existsSync).mockReset();
  vi.mocked(execFile).mockReset();
});

describe('augmentedPath', () => {
  it('appends the global-bin dirs after the caller PATH', () => {
    expect(augmentedPath({ PATH: '/my/bin' })).toBe(['/my/bin', ...EXTRA_DIRS].join(delimiter));
  });

  it('tolerates an absent or empty PATH without a leading empty segment', () => {
    const extrasOnly = EXTRA_DIRS.join(delimiter);
    expect(augmentedPath({})).toBe(extrasOnly);
    expect(augmentedPath({ PATH: '' })).toBe(extrasOnly);
  });
});

describe('resolveAfterburner', () => {
  it('returns the binary when it exists on an augmented dir', () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/usr/local/bin/afterburner');
    expect(resolveAfterburner({ PATH: '' })).toBe('/usr/local/bin/afterburner');
  });

  it('returns null when it is nowhere on the augmented PATH', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveAfterburner({ PATH: '/x' })).toBeNull();
  });

  it('win32: probes .cmd before .exe before the bare name', () => {
    setPlatform('win32');
    const dir = '/binz';
    // Both a .cmd and a .exe exist — .cmd must win.
    vi.mocked(existsSync).mockImplementation(
      (p) => p === join(dir, 'afterburner.cmd') || p === join(dir, 'afterburner.exe'),
    );
    expect(resolveAfterburner({ PATH: dir })).toBe(join(dir, 'afterburner.cmd'));

    // With no .cmd, it falls through to .exe.
    vi.mocked(existsSync).mockImplementation((p) => p === join(dir, 'afterburner.exe'));
    expect(resolveAfterburner({ PATH: dir })).toBe(join(dir, 'afterburner.exe'));
  });

  it('posix: probes only the bare name — a stray .cmd is ignored', () => {
    // Default platform (darwin): exts is [''] only.
    vi.mocked(existsSync).mockImplementation((p) => p === join('/binz', 'afterburner.cmd'));
    expect(resolveAfterburner({ PATH: '/binz' })).toBeNull();
  });
});

describe('runAfterburner', () => {
  it('rejects "afterburner not installed" and never execs when the binary is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    await expect(runAfterburner(['status'])).rejects.toThrow('afterburner not installed');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('posix: execs the bare binary with NO shell and the augmented PATH; resolves stdout', async () => {
    vi.stubEnv('PATH', '/testpath');
    vi.mocked(existsSync).mockImplementation((p) => p === '/usr/local/bin/afterburner');
    onExec((cb) => cb(null, 'OK'));

    await expect(runAfterburner(['status', '--json'])).resolves.toBe('OK');
    const [file, args, opts] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe('/usr/local/bin/afterburner'); // literal, not quoted
    expect(args).toEqual(['status', '--json']);
    expect(opts).toMatchObject({ shell: false, timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    expect((opts as { env: NodeJS.ProcessEnv }).env.PATH).toBe(augmentedPath());
  });

  it('posix: a binary path with a space is passed literally — quoting is shell-only', async () => {
    vi.stubEnv('PATH', '/opt/my apps/bin');
    vi.mocked(existsSync).mockImplementation((p) => p === '/opt/my apps/bin/afterburner');
    onExec((cb) => cb(null, ''));

    await runAfterburner(['x']);
    const [file, , opts] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe('/opt/my apps/bin/afterburner'); // no quotes under shell:false
    expect(opts).toMatchObject({ shell: false });
  });

  it('win32 .cmd: self-quotes the binary and runs it through a shell', async () => {
    setPlatform('win32');
    vi.stubEnv('PATH', '/opt/my apps/bin');
    const bin = join('/opt/my apps/bin', 'afterburner.cmd');
    vi.mocked(existsSync).mockImplementation((p) => p === bin);
    onExec((cb) => cb(null, 'OUT'));

    await expect(runAfterburner(['review', '--json'])).resolves.toBe('OUT');
    const [file, args, opts] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe(`"${bin}"`); // quoted so a space in the path can't be split by cmd.exe
    expect(args).toEqual(['review', '--json']);
    expect(opts).toMatchObject({ shell: true });
    expect((opts as { env: NodeJS.ProcessEnv }).env.PATH).toBe(augmentedPath());
  });

  it('passes the timeout through and rejects on a non-zero / timed-out child', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/usr/local/bin/afterburner');
    onExec((cb) => cb(new Error('boom'), ''));

    await expect(runAfterburner(['run-once'], 15 * 60_000)).rejects.toThrow('boom');
    expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({ timeout: 15 * 60_000 });
  });
});
