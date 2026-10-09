import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SlotSettings } from './actions/slot';

const execFileP = promisify(execFile);
// Bound every helper spawn like mic-control.ts: a wedged defaults or sips must reject, not leave a
// slot render (and a live /slot edit waiting on it) pending forever.
const run = (cmd: string, args: string[]) => execFileP(cmd, args, { encoding: 'utf8', timeout: 4000 });

/** Cap on an explicit image-file icon: a key face is tiny, so refuse anything large rather than
 * base64 a huge file into memory / the SVG. */
const MAX_ICON_BYTES = 512 * 1024;

/** Resolved-icon cache, keyed by the source (app path or image path). `null` = "we looked and there
 * is none", so a missing icon isn't re-probed on every repaint (which happens on every board change
 * plus a 30s tick, and each miss costs a `defaults` + `sips` shell-out).
 *
 * A negative entry MUST be clearable. It records a moment in time — the app wasn't installed yet,
 * the extraction lost a race at startup — and without invalidation that moment becomes permanent:
 * the key can never show its logo again for the life of the plugin, and nothing the user does
 * through the UI fixes it. `forgetIcon` is called whenever a slot is retargeted, so re-setting the
 * key through `jetstream chat` re-resolves instead of replaying the old failure. */
const cache = new Map<string, string | null>();
/** Bumped by every forgetIcon, so an extraction that started before the forget cannot write its
 * (possibly negative) result back into the cache afterwards. */
let cacheGeneration = 0;

/** Drop a cached icon so the next render re-resolves it. Pass a source (app path / image path) to
 * clear one, or nothing to clear all. Call this on any EXPLICIT user edit of a key. */
export function forgetIcon(source?: string): void {
  cacheGeneration++;
  if (source === undefined) cache.clear();
  else cache.delete(source);
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** MIME for an image file by extension, or undefined for an unsupported type. Pure. */
export function imageMime(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()];
}

/** Resolve CFBundleIconFile → the `.icns` path under Resources, adding a missing `.icns` extension.
 * Takes an existence probe so it's pure/testable. Undefined when no matching file exists. */
export function resolveIcnsPath(
  resourcesDir: string,
  iconName: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const name = iconName.trim();
  if (!name) return undefined;
  const withExt = name.toLowerCase().endsWith('.icns') ? name : `${name}.icns`;
  for (const candidate of [join(resourcesDir, name), join(resourcesDir, withExt)]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Read an image file into a data URI, or undefined if it's missing, an unsupported type, not a
 * regular file, or larger than a key face has any business being. */
function fileToDataUri(path: string): string | undefined {
  const mime = imageMime(path);
  if (!mime || !existsSync(path)) return undefined;
  let fd: number | undefined;
  try {
    // A device or FIFO behind an image name reports size 0, so check what was opened, not the path.
    // O_NONBLOCK keeps a FIFO with no writer from hanging the open on the plugin's only thread.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return undefined;
    // Read one byte past the cap at most, so a file that grew after the fstat is still refused.
    const buf = Buffer.alloc(MAX_ICON_BYTES + 1);
    let size = 0;
    while (size < buf.length) {
      const n = readSync(fd, buf, size, buf.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > MAX_ICON_BYTES) return undefined;
    return `data:${mime};base64,${buf.subarray(0, size).toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A macOS app bundle's icon as a 144px PNG data URI, or undefined (not macOS, not an app bundle, an
 * asset-catalog icon with no loose `.icns`, or an extraction failure). Cached per app path — the
 * `defaults`/`sips` shell-out runs once. */
export async function appIconDataUri(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
  // Injected so a test can drive the negative-cache lifecycle without shelling out to defaults/sips.
  // Same default-parameter DI as `platform` above; production always uses the real extractor.
  // It resolves undefined for a definite miss (cached) and rejects for a transient one (retried).
  extract: (p: string) => Promise<string | undefined> = extractAppIcon,
): Promise<string | undefined> {
  if (platform !== 'darwin' || !appPath.endsWith('.app') || !existsSync(appPath)) return undefined;
  const hit = cache.get(appPath);
  if (hit !== undefined) return hit ?? undefined;
  const generation = cacheGeneration;
  let uri: string | undefined;
  try {
    uri = await extract(appPath);
  } catch {
    // A helper killed by its timeout says nothing about the app, so leave no negative entry: the
    // next render retries. The reason is already in `failures`.
    return undefined;
  }
  if (generation === cacheGeneration) cache.set(appPath, uri ?? null);
  return uri;
}

/** True when a helper never gave an answer: killed by the timeout (no exit code) or never spawned (an
 * errno string). A helper that exited non-zero did answer (no such key, an unconvertible icns). */
function isTransient(error: unknown): boolean {
  return typeof (error as { code?: unknown }).code !== 'number';
}

/** Why the last extraction failed, per app path — surfaced by `iconFailureReason` so a key stuck on
 * its text face is diagnosable. Every failure here is swallowed (an icon is cosmetic and must never
 * break a repaint), which previously meant a missing logo left no trace anywhere at all. */
const failures = new Map<string, string>();

/** The reason an app's icon could not be extracted, if it was tried and failed. */
export function iconFailureReason(appPath: string): string | undefined {
  return failures.get(appPath);
}

async function extractAppIcon(appPath: string): Promise<string | undefined> {
  failures.delete(appPath);
  let iconName: string;
  try {
    const { stdout } = await run('defaults', ['read', join(appPath, 'Contents', 'Info'), 'CFBundleIconFile']);
    iconName = stdout.trim();
  } catch (error) {
    if (isTransient(error)) {
      const why = (error as Error).message;
      failures.set(appPath, `defaults gave no CFBundleIconFile answer, retried next render: ${why}`);
      throw error;
    }
    // No CFBundleIconFile (the icon lives in an asset catalog) or an unreadable Info.plist.
    failures.set(appPath, 'no CFBundleIconFile — the icon is in an asset catalog, not a loose .icns');
    return undefined;
  }
  const icns = resolveIcnsPath(join(appPath, 'Contents', 'Resources'), iconName);
  if (!icns) {
    failures.set(appPath, `CFBundleIconFile "${iconName}" has no matching .icns under Resources/`);
    return undefined;
  }
  // A temp file of its own per extraction: two extractions of the same app (a render and a live
  // retarget) must never read each other's half-written PNG.
  const out = join(
    tmpdir(),
    `jetstream-icon-${createHash('sha1').update(appPath).digest('hex').slice(0, 16)}-${randomBytes(4).toString('hex')}.png`,
  );
  try {
    // argv array, never a shell; -Z scales the longest side to 144 for a 144px key.
    await run('sips', ['-s', 'format', 'png', '-Z', '144', icns, '--out', out]);
  } catch (error) {
    rmSync(out, { force: true });
    failures.set(appPath, `sips could not convert ${icns}: ${(error as Error).message}`);
    if (isTransient(error)) throw error;
    return undefined;
  }
  // sips answered, so a missing or unreadable PNG is a definite miss: cached, not re-spawned.
  try {
    return `data:image/png;base64,${readFileSync(out).toString('base64')}`;
  } catch (error) {
    failures.set(appPath, `sips exited 0 but left no readable PNG for ${icns}: ${(error as Error).message}`);
    return undefined;
  } finally {
    rmSync(out, { force: true });
  }
}

/** The bundled Jetstream mark as a data URI, for the 'logo' slot kind. `imgs/plugin.png` ships
 * inside the .sdPlugin next to the bundled `bin/`, so we resolve it relative to THIS module at
 * runtime — correct wherever the plugin is installed. Cached (the asset never changes); returns
 * undefined outside the bundle (e.g. tests) so the caller falls back to the text face. `assetPath`
 * is injectable for tests. */
let logoCache: string | null | undefined;
export function logoDataUri(assetPath?: string): string | undefined {
  if (assetPath !== undefined) return fileToDataUri(assetPath); // test path — never cached
  if (logoCache === undefined) {
    logoCache = fileToDataUri(fileURLToPath(new URL('../imgs/plugin.png', import.meta.url))) ?? null;
  }
  return logoCache ?? undefined;
}

/**
 * The image a slot should paint, as a data URI, or undefined → render the text face. An explicit
 * `icon` (a data URI or an image file path) wins; a 'logo' slot shows the bundled Jetstream mark;
 * otherwise an app slot shows the app's own icon — so an app shortcut looks like the real thing
 * (the Telegram key shows the Telegram logo), with no command needed.
 */
export async function resolveSlotIcon(
  settings: SlotSettings,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const icon = settings.icon?.trim();
  if (icon) return icon.startsWith('data:') ? icon : fileToDataUri(icon);
  if (settings.kind === 'logo') return logoDataUri();
  if (settings.kind === 'app' && settings.app) return appIconDataUri(settings.app, platform);
  return undefined;
}
