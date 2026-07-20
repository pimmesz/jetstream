import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDoctorInTerminal } from './exec-terminal';

// Mock the fs writers + child_process; keep os/path real so the expected launcher path is
// computed with the exact join the source uses.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdtempSync: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

// The private dir mkdtemp hands back; tests write the launcher into it deterministically.
const DIR = join(tmpdir(), 'jetstream-doctor-test');

// execFile is overloaded; drive its node-style callback (the 4th arg — file, args, options, cb)
// from a plain impl and cast past the types.
const onExec = (err: Error | null): void => {
  vi.mocked(execFile).mockImplementation(((_f: string, _a: unknown, _o: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    cb(err, '', '');
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
};

afterEach(() => {
  setPlatform(realPlatform);
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(chmodSync).mockReset();
  vi.mocked(mkdtempSync).mockReset();
  vi.mocked(execFile).mockReset();
});

describe('openDoctorInTerminal', () => {
  it('macOS: writes an executable launcher in a private temp dir, opens it, resolves true', async () => {
    setPlatform('darwin');
    vi.mocked(mkdtempSync).mockReturnValue(DIR);
    onExec(null);

    await expect(openDoctorInTerminal()).resolves.toBe(true);
    const file = join(DIR, 'doctor.command');
    const [written, body] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(written).toBe(file);
    expect(body).toContain('jetstream doctor');
    expect(body).toContain('exec "$SHELL"'); // window stays open at a prompt
    expect(vi.mocked(chmodSync)).toHaveBeenCalledWith(file, 0o755); // must be executable to open
    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0]!;
    expect(cmd).toBe('open');
    expect(args).toEqual([file]);
    expect(opts).toMatchObject({ timeout: 10_000 }); // the promise always settles
  });

  it('Windows: prepends the npm global bin, runs from the private dir by basename via cmd /k', async () => {
    setPlatform('win32');
    vi.mocked(mkdtempSync).mockReturnValue(DIR);
    onExec(null);

    await expect(openDoctorInTerminal()).resolves.toBe(true);
    const [written, body] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(written).toBe(join(DIR, 'doctor.cmd'));
    expect(body).toContain('jetstream doctor');
    expect(body).toContain('%APPDATA%\\npm'); // so a normally-installed jetstream resolves
    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0]!;
    expect(cmd).toBe('cmd');
    // Bare basename + cwd, so a cmd metacharacter in the temp PATH can't be re-parsed by cmd.exe.
    expect(args).toEqual(['/c', 'start', '', 'cmd', '/k', 'doctor.cmd']);
    expect(opts).toMatchObject({ cwd: DIR, timeout: 10_000 });
  });

  it('resolves false when the launcher spawn errors — no false OK', async () => {
    setPlatform('darwin');
    vi.mocked(mkdtempSync).mockReturnValue(DIR);
    onExec(new Error('spawn open ENOENT'));
    await expect(openDoctorInTerminal()).resolves.toBe(false);
  });

  it('unsupported platform: resolves false and spawns nothing', async () => {
    setPlatform('linux');
    await expect(openDoctorInTerminal()).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
    expect(mkdtempSync).not.toHaveBeenCalled();
  });

  it('resolves false (never rejects) when creating the launcher fails', async () => {
    setPlatform('darwin');
    vi.mocked(mkdtempSync).mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    await expect(openDoctorInTerminal()).resolves.toBe(false); // a keypress must not throw
    expect(execFile).not.toHaveBeenCalled();
  });
});
