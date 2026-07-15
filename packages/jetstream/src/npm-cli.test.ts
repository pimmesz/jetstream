import type { spawn as spawnType } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bundledPluginPath,
  errRed,
  forwardedArgs,
  installPlugin,
  resolveJetstreamCli,
  runJetstream,
} from './npm-cli';

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-npm-'));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Create the installed-plugin CLI under `root/<extra…>` and return its dir. */
const installCli = (root: string, ...extra: string[]): void => {
  const dir = join(root, ...extra, 'gg.pim.jetstream.sdPlugin', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jetstream.js'), '// built cli');
};

describe('resolveJetstreamCli', () => {
  it('finds the plugin CLI at the macOS Elgato location', () => {
    const home = makeTmp();
    installCli(home, 'Library', 'Application Support', 'com.elgato.StreamDeck', 'Plugins');
    const cli = resolveJetstreamCli('darwin', {}, home);
    expect(cli).toBe(
      join(
        home,
        'Library',
        'Application Support',
        'com.elgato.StreamDeck',
        'Plugins',
        'gg.pim.jetstream.sdPlugin',
        'bin',
        'jetstream.js',
      ),
    );
  });

  it('finds it at the Windows %APPDATA% location', () => {
    const appData = makeTmp();
    installCli(appData, 'Elgato', 'StreamDeck', 'Plugins');
    const cli = resolveJetstreamCli('win32', { APPDATA: appData }, makeTmp());
    expect(cli).toBe(
      join(
        appData,
        'Elgato',
        'StreamDeck',
        'Plugins',
        'gg.pim.jetstream.sdPlugin',
        'bin',
        'jetstream.js',
      ),
    );
  });

  it('returns null when the plugin is not installed', () => {
    expect(resolveJetstreamCli('darwin', {}, makeTmp())).toBeNull();
  });

  it('returns null on win32 without APPDATA, and on unsupported platforms', () => {
    expect(resolveJetstreamCli('win32', {}, makeTmp())).toBeNull();
    expect(resolveJetstreamCli('linux', {}, makeTmp())).toBeNull();
  });
});

describe('forwardedArgs', () => {
  // The npm bin IS `jetstream`, so everything after argv[1] belongs to the child — unlike
  // afterburner's `afterburner jetstream <args>`, which had to skip the subcommand name.
  it('forwards everything after the bin name, flags included', () => {
    expect(forwardedArgs(['node', '/usr/local/bin/jetstream', 'init'])).toEqual(['init']);
    expect(
      forwardedArgs(['node', '/usr/local/bin/jetstream', 'hooks', 'install', '--tool-detail']),
    ).toEqual(['hooks', 'install', '--tool-detail']);
    expect(forwardedArgs(['node', '/usr/local/bin/jetstream', '--help'])).toEqual(['--help']);
  });

  it('is empty when the bin is invoked bare', () => {
    expect(forwardedArgs(['node', '/usr/local/bin/jetstream'])).toEqual([]);
  });
});

describe('errRed', () => {
  // NO_COLOR is honoured by errRed, so every case here pins it explicitly rather than
  // inheriting it: CI runners and some shells export NO_COLOR=1, which would otherwise
  // make the colour case pass or fail depending on whose machine ran the suite.
  afterEach(() => vi.unstubAllEnvs());

  it('emits colour for a TTY stream', () => {
    vi.stubEnv('NO_COLOR', undefined);
    expect(errRed('boom', { isTTY: true })).toContain('[31m');
    expect(errRed('boom', { isTTY: true })).toContain('boom');
  });

  it('stays plain when stderr is piped — no escape codes in a log file', () => {
    vi.stubEnv('NO_COLOR', undefined);
    expect(errRed('boom', { isTTY: false })).toBe('boom');
    expect(errRed('boom', {})).toBe('boom');
  });

  it('honours NO_COLOR even on a TTY', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(errRed('boom', { isTTY: true })).toBe('boom');
  });
});

describe('runJetstream', () => {
  // A fake child whose exit/error handlers we can fire on demand.
  const fakeChild = () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event] = cb;
        return this;
      },
      fire(event: string, arg?: unknown) {
        handlers[event]?.(arg);
      },
    };
  };

  it('plugin not found → error points at `jetstream install`, exit 1, never spawns', () => {
    const error = vi.fn();
    const setExitCode = vi.fn();
    const spawn = vi.fn();
    runJetstream({
      resolve: () => null,
      spawn: spawn as unknown as typeof spawnType,
      args: ['doctor'],
      error,
      setExitCode,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('jetstream install');
    // The old afterburner-routed instruction must not survive the split.
    expect(error.mock.calls[0]![0]).not.toContain('afterburner');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('`install` is handled here, never resolved/forwarded to the plugin CLI', () => {
    const install = vi.fn();
    const resolve = vi.fn(() => '/plugin/bin/jetstream.js');
    const spawn = vi.fn();
    runJetstream({
      args: ['install'],
      install,
      resolve,
      spawn: spawn as unknown as typeof spawnType,
    });
    expect(install).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled(); // never looks for an installed CLI
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns node on the resolved CLI with the forwarded args', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    runJetstream({
      resolve: () => '/plugin/bin/jetstream.js',
      spawn: spawn as unknown as typeof spawnType,
      args: ['init', '--tool-detail'],
      error: vi.fn(),
      setExitCode: vi.fn(),
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/plugin/bin/jetstream.js', 'init', '--tool-detail'],
      { stdio: 'inherit' },
    );
  });

  it('propagates the child exit code (incl. non-zero)', () => {
    const child = fakeChild();
    const setExitCode = vi.fn();
    runJetstream({
      resolve: () => '/x/jetstream.js',
      spawn: (() => child) as unknown as typeof spawnType,
      args: [],
      error: vi.fn(),
      setExitCode,
    });
    child.fire('exit', 3);
    expect(setExitCode).toHaveBeenCalledWith(3);
  });

  it('a spawn error surfaces a message and exit 1', () => {
    const child = fakeChild();
    const error = vi.fn();
    const setExitCode = vi.fn();
    runJetstream({
      resolve: () => '/x/jetstream.js',
      spawn: (() => child) as unknown as typeof spawnType,
      args: [],
      error,
      setExitCode,
    });
    child.fire('error', new Error('ENOENT'));
    expect(error.mock.calls.at(-1)![0]).toContain('ENOENT');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});

describe('installPlugin', () => {
  const fakeChild = () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event] = cb;
        return this;
      },
      fire(event: string, arg?: unknown) {
        handlers[event]?.(arg);
      },
    };
  };

  it('missing packed artifact → error + exit 1, never spawns', () => {
    const error = vi.fn();
    const setExitCode = vi.fn();
    const spawn = vi.fn();
    installPlugin({
      exists: () => false,
      artifactPath: '/pkg/assets/gg.pim.jetstream.streamDeckPlugin',
      spawn: spawn as unknown as typeof spawnType,
      error,
      setExitCode,
      say: vi.fn(),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain('packed Jetstream plugin is missing');
    expect(error.mock.calls[0]![0]).toContain('@pimmesz/jetstream');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('macOS: opens the artifact with `open`', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const say = vi.fn();
    installPlugin({
      exists: () => true,
      artifactPath: '/pkg/plugin.streamDeckPlugin',
      platform: 'darwin',
      spawn: spawn as unknown as typeof spawnType,
      say,
      error: vi.fn(),
      setExitCode: vi.fn(),
    });
    expect(spawn).toHaveBeenCalledWith('open', ['/pkg/plugin.streamDeckPlugin'], {
      stdio: 'inherit',
    });
    expect(say.mock.calls[0]![0]).toContain('Stream Deck');
  });

  it('Windows: opens via `cmd /c start`', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    installPlugin({
      exists: () => true,
      artifactPath: 'C:\\pkg\\plugin.streamDeckPlugin',
      platform: 'win32',
      spawn: spawn as unknown as typeof spawnType,
      say: vi.fn(),
      error: vi.fn(),
      setExitCode: vi.fn(),
    });
    expect(spawn).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'C:\\pkg\\plugin.streamDeckPlugin'],
      { stdio: 'inherit' },
    );
  });

  it('a failure to open (no Stream Deck app) → error + exit 1', () => {
    const child = fakeChild();
    const error = vi.fn();
    const setExitCode = vi.fn();
    installPlugin({
      exists: () => true,
      artifactPath: '/pkg/plugin.streamDeckPlugin',
      platform: 'darwin',
      spawn: (() => child) as unknown as typeof spawnType,
      say: vi.fn(),
      error,
      setExitCode,
    });
    child.fire('error', new Error('spawn open ENOENT'));
    expect(error.mock.calls.at(-1)![0]).toContain('Stream Deck app installed');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});

describe('bundledPluginPath', () => {
  it('resolves under the package root (walking up to package.json)', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), '{}');
    const nested = join(root, 'dist');
    mkdirSync(nested, { recursive: true });
    const moduleUrl = pathToFileURL(join(nested, 'npm-cli.js')).href;
    expect(bundledPluginPath(moduleUrl)).toBe(
      join(root, 'assets', 'gg.pim.jetstream.streamDeckPlugin'),
    );
  });
});
