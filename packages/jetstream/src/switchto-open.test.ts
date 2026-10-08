import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Never launch a real opener from a test: a gate that failed would run the script below.
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));
import { spawn } from 'node:child_process';
import { config } from './config';
import { openProjectFromKey } from './switchto';

describe('openProjectFromKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-open-project-'));
  const deploy = join(dir, 'deploy');
  writeFileSync(deploy, '#!/bin/sh\nexit 0\n');
  chmodSync(deploy, 0o755);
  const repo = join(dir, 'three.js');
  mkdirSync(repo);
  afterEach(() => config.set(undefined));

  it('refuses a project path that would run something while run keys are off, and opens a repo folder', async () => {
    vi.mocked(spawn).mockClear();
    expect(await openProjectFromKey(deploy)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(await openProjectFromKey(repo)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('opens it once run keys are on', async () => {
    config.set({ allowRunKeys: true });
    vi.mocked(spawn).mockClear();
    expect(await openProjectFromKey(deploy)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
