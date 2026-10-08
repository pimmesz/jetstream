import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync, type WriteFileOptions } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Replace `path` with `data` atomically: a complete temp file in the same folder, renamed over the
 * old one, so a reader never sees a half-written file and a crash leaves the old file intact. The
 * temp name is unique per call (two writers never share one) and is removed if anything fails.
 */
export function writeFileAtomicSync(path: string, data: string, options?: WriteFileOptions): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.jetstream-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, data, options);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true }); // gone after a successful rename; a leftover after a failure
  }
}
