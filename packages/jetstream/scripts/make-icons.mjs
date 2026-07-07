// Generate the manifest's plugin icon as a PNG (Elgato requires PNG for the
// plugin-level Icon; the per-action SVGs validate fine). No image deps: a tiny
// raster (rounded jet-blue tile + white delta glyph) encoded with node:zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const raw = Buffer.alloc(size * (1 + size * 4)); // filter byte + RGBA per row
  const radius = size * 0.17;
  const inTile = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 || (x >= radius && x <= size - radius) || (y >= radius && y <= size - radius)
      ? (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
      : false;
  };
  // White delta (jet) glyph: triangle from 33%..67% width, 20%..80% height.
  const inGlyph = (x, y) => {
    const t = (y - size * 0.2) / (size * 0.6);
    if (t < 0 || t > 1) return false;
    const half = (size * 0.17) * t;
    return Math.abs(x - size / 2) <= half;
  };
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4) + 1;
    for (let x = 0; x < size; x++) {
      const i = row + x * 4;
      if (!inTile(x + 0.5, y + 0.5)) continue; // transparent corner
      const glyph = inGlyph(x + 0.5, y + 0.5);
      raw[i] = glyph ? 0xff : 0x00;
      raw[i + 1] = glyph ? 0xff : 0x91;
      raw[i + 2] = 0xff;
      raw[i + 3] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const imgs = join(dirname(fileURLToPath(import.meta.url)), '..', 'gg.pim.jetstream.sdPlugin', 'imgs');
writeFileSync(join(imgs, 'plugin.png'), png(288));
writeFileSync(join(imgs, 'plugin@2x.png'), png(576));
console.log('imgs/plugin.png (288) + plugin@2x.png (576) written');
