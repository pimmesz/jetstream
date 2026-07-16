import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appIconDataUri, imageMime, logoDataUri, resolveIcnsPath, resolveSlotIcon } from './slot-icon';

describe('imageMime', () => {
  it('maps supported image extensions, undefined otherwise', () => {
    expect(imageMime('/x/logo.PNG')).toBe('image/png');
    expect(imageMime('/x/a.jpg')).toBe('image/jpeg');
    expect(imageMime('/x/a.svg')).toBe('image/svg+xml');
    expect(imageMime('/x/a.icns')).toBeUndefined();
    expect(imageMime('/x/a')).toBeUndefined();
  });
});

describe('resolveIcnsPath', () => {
  const has = (...present: string[]) => (p: string) => present.includes(p);
  it('finds the icns as-named, else appends the .icns extension', () => {
    expect(resolveIcnsPath('/App/Resources', 'AppIcon', has('/App/Resources/AppIcon.icns'))).toBe(
      '/App/Resources/AppIcon.icns',
    );
    expect(resolveIcnsPath('/App/Resources', 'Icon.icns', has('/App/Resources/Icon.icns'))).toBe(
      '/App/Resources/Icon.icns',
    );
    expect(resolveIcnsPath('/App/Resources', 'AppIcon', has())).toBeUndefined();
    expect(resolveIcnsPath('/App/Resources', '', has('/App/Resources/.icns'))).toBeUndefined();
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveSlotIcon', () => {
  it('passes a data: URI icon through unchanged', async () => {
    expect(await resolveSlotIcon({ kind: 'app', app: '/x.app', icon: 'data:image/png;base64,AAA' })).toBe(
      'data:image/png;base64,AAA',
    );
  });
  it('reads an explicit image-file icon into a data URI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-icon-'));
    tmpDirs.push(dir);
    const png = join(dir, 'logo.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    const uri = await resolveSlotIcon({ kind: 'url', url: 'https://x.com', icon: png });
    expect(uri).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
  });
  it('is undefined for an empty slot, and for an app slot off macOS', async () => {
    expect(await resolveSlotIcon({ kind: 'empty' })).toBeUndefined();
    expect(await resolveSlotIcon({ kind: 'app', app: '/Applications/X.app' }, 'linux')).toBeUndefined();
    expect(await resolveSlotIcon({ kind: 'url', url: 'https://x.com' })).toBeUndefined(); // no icon, url doesn't self-icon
  });
  it('drops an unsupported / missing explicit icon file', async () => {
    expect(await resolveSlotIcon({ kind: 'app', app: '/x.app', icon: '/nope/missing.png' })).toBeUndefined();
    expect(await resolveSlotIcon({ kind: 'app', app: '/x.app', icon: '/x/notimage.txt' })).toBeUndefined();
  });
  it('rejects an oversized image-file icon (a key face is tiny)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-icon-'));
    tmpDirs.push(dir);
    const big = join(dir, 'big.png');
    writeFileSync(big, Buffer.alloc(600 * 1024)); // > the 512 KB cap
    expect(await resolveSlotIcon({ kind: 'app', app: '/x.app', icon: big })).toBeUndefined();
  });
  it('a logo slot paints the bundled mark, and an explicit icon still wins', async () => {
    // The default bundle asset can't be read from the source tree, so an explicit icon proves the
    // logo path resolves an image; a data: URI still overrides it.
    expect(await resolveSlotIcon({ kind: 'logo', icon: 'data:image/png;base64,ZZZ' })).toBe(
      'data:image/png;base64,ZZZ',
    );
  });
});

describe('logoDataUri', () => {
  it('reads the given asset into a PNG data URI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-icon-'));
    tmpDirs.push(dir);
    const png = join(dir, 'plugin.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(png, bytes);
    expect(logoDataUri(png)).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });
  it('is undefined when the asset is missing (e.g. running outside the plugin bundle)', () => {
    expect(logoDataUri('/nope/does-not-exist.png')).toBeUndefined();
  });
});

describe('appIconDataUri (guards)', () => {
  it('is undefined off macOS or for a non-app path', async () => {
    expect(await appIconDataUri('/Applications/X.app', 'win32')).toBeUndefined();
    expect(await appIconDataUri('/Applications/notanapp', 'darwin')).toBeUndefined();
  });
});
