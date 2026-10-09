import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerTokenPaths, readToken } from './listener-token';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'js-hook-token-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('listenerTokenPaths', () => {
  it('is only ~/.config/jetstream when XDG_CONFIG_HOME is unset, where the plugin always mints', () => {
    expect(listenerTokenPaths({}, '/h')).toEqual([join('/h', '.config', 'jetstream', 'listener-token')]);
  });

  it('tries the XDG path first, then still ~/.config, so a GUI-minted token is found from a shell', () => {
    expect(listenerTokenPaths({ XDG_CONFIG_HOME: '/x' }, '/h')).toEqual([
      join('/x', 'jetstream', 'listener-token'),
      join('/h', '.config', 'jetstream', 'listener-token'),
    ]);
  });
});

describe('readToken', () => {
  it('finds a token written only at the ~/.config candidate when XDG points at an empty dir', () => {
    const home = tmp();
    const xdg = tmp();
    mkdirSync(join(home, '.config', 'jetstream'), { recursive: true });
    writeFileSync(join(home, '.config', 'jetstream', 'listener-token'), 'a'.repeat(64));
    expect(readToken(listenerTokenPaths({ XDG_CONFIG_HOME: xdg }, home))).toBe('a'.repeat(64));
  });
});
