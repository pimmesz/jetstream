import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Optional power-user helper. On a VOLUME-FIXED interface (e.g. a Focusrite Scarlett) the macOS
 * output master is a no-op — but Background Music's PER-APP volumes are real software gain. If the
 * user has installed the `bgm-vol` helper (drives BGM's per-app DSP as a pseudo-master), prefer it;
 * otherwise fall back to the standard osascript master, which works on any device that exposes a real
 * software volume (laptop speakers, most USB outputs, a virtual device with a working master).
 */
const BGM_VOL = join(homedir(), '.local', 'bin', 'bgm-vol');
const haveBgmVol = (): boolean => existsSync(BGM_VOL);

/** Read the default OUTPUT (monitor) volume 0-100, or undefined off-macOS / when the device exposes no
 * software volume. A bare pro interface (e.g. a Focusrite Scarlett) returns `missing value` → undefined;
 * putting a virtual gain device (Background Music, SoundSource, …) in front makes it controllable. argv,
 * never a shell. */
export async function readOutputVolume(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await run('osascript', ['-e', 'output volume of (get volume settings)']);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : undefined; // 'missing value' → NaN → undefined
  } catch {
    return undefined;
  }
}

/** Nudge the default output volume by `delta` (clamped 0-100). No-op off-macOS or when the output has no
 * software volume. Best-effort — the key already gave press feedback. */
export async function nudgeOutputVolume(delta: number): Promise<void> {
  if (haveBgmVol()) {
    try {
      await run(BGM_VOL, ['nudge', String(Math.round(delta))]); // nudge EVERY BGM-routed app at once
    } catch {
      /* best-effort */
    }
    return;
  }
  const current = await readOutputVolume();
  if (current === undefined) return;
  const next = Math.max(0, Math.min(100, Math.round(current + delta)));
  try {
    await run('osascript', ['-e', `set volume output volume ${next}`]);
  } catch {
    /* best-effort */
  }
}

/** Toggle the default output mute. Prefers the bgm-vol helper (mutes/restores all BGM-routed apps);
 * else the osascript master. No-op off-macOS; best-effort. */
export async function toggleOutputMute(): Promise<void> {
  if (haveBgmVol()) {
    try {
      await run(BGM_VOL, ['mute']); // toggles all BGM-routed apps between 0 and their saved levels
    } catch {
      /* best-effort */
    }
    return;
  }
  if (process.platform !== 'darwin') return;
  try {
    await run('osascript', ['-e', 'set volume output muted (not (output muted of (get volume settings)))']);
  } catch {
    /* best-effort */
  }
}
