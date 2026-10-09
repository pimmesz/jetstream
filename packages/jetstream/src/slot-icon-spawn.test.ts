import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appIconDataUri, iconFailureReason, resolveSlotIcon } from './slot-icon';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

/** Fake helpers: `wedged` never answers on its own and fails only once the caller's `timeout` runs
 * out, the way execFile kills a child that outlives it (killed, no exit code). `failing` exits 1.
 * Every other helper answers at once: defaults names the icon, sips writes its --out PNG unless
 * `isPngMissing`. The callback is the 4th arg (file, args, options, cb). */
function fakeHelpers({
  wedged,
  failing,
  isPngMissing,
}: { wedged?: string; failing?: string; isPngMissing?: boolean } = {}): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    options: { timeout?: number } | undefined,
    cb: (e: Error | null, out?: { stdout: string }) => void,
  ) => {
    if (file === wedged) {
      const timedOut = Object.assign(new Error(`${file} was killed after its timeout`), { killed: true, signal: 'SIGTERM', code: null });
      if (options?.timeout) setTimeout(() => cb(timedOut), options.timeout);
    } else if (file === failing) {
      cb(Object.assign(new Error(`${file} exited 1`), { killed: false, signal: null, code: 1 }));
    } else {
      const out = args.at(-1);
      if (file === 'sips' && out && !isPngMissing) writeFileSync(out, 'PNG');
      cb(null, { stdout: 'AppIcon\n' });
    }
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

const PNG_URI = `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`;

const tmpDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(execFile).mockReset();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real .app with a loose AppIcon.icns, so only the helpers decide the outcome. */
function makeApp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-icon-spawn-'));
  tmpDirs.push(dir);
  const app = join(dir, 'Probe.app');
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Resources', 'AppIcon.icns'), '');
  return app;
}

describe('app icon extraction with a wedged helper', () => {
  it.each([
    ['defaults', /CFBundleIconFile/],
    ['sips', /sips could not convert/],
  ])('a wedged %s settles as a recorded failure within 4 s', async (helper, reason) => {
    vi.useFakeTimers();
    const app = makeApp();
    fakeHelpers({ wedged: helper });
    let isSettled = false;
    const icon = appIconDataUri(app, 'darwin').finally(() => (isSettled = true));
    await vi.advanceTimersByTimeAsync(4000);
    expect(isSettled).toBe(true);
    expect(await icon).toBeUndefined();
    expect(iconFailureReason(app)).toMatch(reason);
  });
});

describe('app icon cache after a failed helper', () => {
  it.each(['defaults', 'sips'])('a %s killed by its timeout is retried on the next render, which paints the icon', async (helper) => {
    vi.useFakeTimers();
    const app = makeApp();
    fakeHelpers({ wedged: helper });
    const first = resolveSlotIcon({ kind: 'app', app }, 'darwin');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await first).toBeUndefined();

    fakeHelpers(); // the machine is no longer busy, so every helper answers
    expect(await resolveSlotIcon({ kind: 'app', app }, 'darwin')).toBe(PNG_URI);
  });

  it.each(['defaults', 'sips'])('a %s that exits non-zero is a definite miss: cached, not re-run', async (helper) => {
    const app = makeApp();
    fakeHelpers({ failing: helper });
    expect(await resolveSlotIcon({ kind: 'app', app }, 'darwin')).toBeUndefined();
    const spawns = vi.mocked(execFile).mock.calls.length;

    fakeHelpers();
    expect(await resolveSlotIcon({ kind: 'app', app }, 'darwin')).toBeUndefined();
    expect(vi.mocked(execFile).mock.calls.length).toBe(spawns);
  });

  it('a sips that exits 0 without writing its PNG is a definite miss: cached, not re-run', async () => {
    const app = makeApp();
    fakeHelpers({ isPngMissing: true });
    expect(await resolveSlotIcon({ kind: 'app', app }, 'darwin')).toBeUndefined();
    expect(iconFailureReason(app)).toMatch(/sips exited 0 but left no readable PNG/);
    const spawns = vi.mocked(execFile).mock.calls.length;

    fakeHelpers();
    expect(await resolveSlotIcon({ kind: 'app', app }, 'darwin')).toBeUndefined();
    expect(vi.mocked(execFile).mock.calls.length).toBe(spawns);
  });
});
