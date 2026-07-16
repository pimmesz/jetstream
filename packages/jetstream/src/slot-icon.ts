import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SlotSettings } from './actions/slot';

const run = promisify(execFile);

/** Cap on an explicit image-file icon: a key face is tiny, so refuse anything large rather than
 * base64 a huge file into memory / the SVG. */
const MAX_ICON_BYTES = 512 * 1024;

/** Resolved-icon cache, keyed by the source (app path or image path). `null` = "we looked and there
 * is none", so a missing icon isn't re-probed on every repaint. */
const cache = new Map<string, string | null>();

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

/** Read an image file into a data URI, or undefined if it's missing, an unsupported type, or larger
 * than a key face has any business being. */
function fileToDataUri(path: string): string | undefined {
  const mime = imageMime(path);
  if (!mime || !existsSync(path)) return undefined;
  try {
    if (statSync(path).size > MAX_ICON_BYTES) return undefined;
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** A macOS app bundle's icon as a 144px PNG data URI, or undefined (not macOS, not an app bundle, an
 * asset-catalog icon with no loose `.icns`, or an extraction failure). Cached per app path — the
 * `defaults`/`sips` shell-out runs once. */
export async function appIconDataUri(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform !== 'darwin' || !appPath.endsWith('.app') || !existsSync(appPath)) return undefined;
  const hit = cache.get(appPath);
  if (hit !== undefined) return hit ?? undefined;
  const uri = await extractAppIcon(appPath);
  cache.set(appPath, uri ?? null);
  return uri;
}

async function extractAppIcon(appPath: string): Promise<string | undefined> {
  let iconName: string;
  try {
    const { stdout } = await run('defaults', ['read', join(appPath, 'Contents', 'Info'), 'CFBundleIconFile']);
    iconName = stdout.trim();
  } catch {
    return undefined; // no CFBundleIconFile (asset-catalog icon) or unreadable Info.plist
  }
  const icns = resolveIcnsPath(join(appPath, 'Contents', 'Resources'), iconName);
  if (!icns) return undefined;
  // Hash the FULL app path so two apps with the same basename (e.g. two "Notes.app") don't race on a
  // shared temp file and cache each other's icon.
  const out = join(tmpdir(), `jetstream-icon-${createHash('sha1').update(appPath).digest('hex').slice(0, 16)}.png`);
  try {
    // argv array, never a shell; -Z scales the longest side to 144 for a 144px key.
    await run('sips', ['-s', 'format', 'png', '-Z', '144', icns, '--out', out]);
    return `data:image/png;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return undefined;
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
