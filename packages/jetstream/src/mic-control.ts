import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Read the default input (mic) device's volume 0-100, or undefined off-macOS / on failure. argv,
 * never a shell. */
export async function readInputVolume(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await run('osascript', ['-e', 'input volume of (get volume settings)']);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Set the default input (mic) device's volume 0-100 (0 = muted). No-op off-macOS; best-effort. */
export async function writeInputVolume(volume: number): Promise<void> {
  if (process.platform !== 'darwin') return;
  const v = Math.max(0, Math.min(100, Math.round(volume)));
  try {
    await run('osascript', ['-e', `set volume input volume ${v}`]);
  } catch {
    /* best-effort — the key already gave feedback */
  }
}
