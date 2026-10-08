import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write';

describe('writeFileAtomicSync', () => {
  it('creates missing folders, replaces the file, applies the mode, and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-atomic-'));
    const path = join(dir, 'nested', 'token');
    writeFileAtomicSync(path, 'one');
    writeFileAtomicSync(path, 'two', { encoding: 'utf8', mode: 0o600 });
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['token']);
  });

  it('keeps the old file and removes its temp when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-atomic-'));
    const target = join(dir, 'occupied');
    mkdirSync(join(target, 'child'), { recursive: true }); // a non-empty folder cannot be renamed over
    expect(() => writeFileAtomicSync(target, 'data')).toThrow();
    expect(readdirSync(dir)).toEqual(['occupied']);
  });
});
