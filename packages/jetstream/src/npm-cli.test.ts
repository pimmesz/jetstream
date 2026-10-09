import type { spawn as spawnType } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bundledPluginPath,
  errRed,
  forwardedArgs,
  installedPluginVersion,
  installPlugin,
  packageVersion,
  pluginReportsVersion,
  PUBLIC_REGISTRY,
  redactRegistry,
  registryEnv,
  resolveJetstreamCli,
  resolveRegistry,
  runJetstream,
  updatePackage,
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
  // The npm bin IS `jetstream`, so everything after argv[1] belongs to the child (no subcommand
  // name to skip).
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

describe('version', () => {
  it("packageVersion reads this package's own semver at runtime", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('installedPluginVersion reads the resolved plugin manifest; null when not installed', () => {
    const dir = makeTmp();
    const bin = join(dir, 'gg.pim.jetstream.sdPlugin', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(dir, 'gg.pim.jetstream.sdPlugin', 'manifest.json'),
      JSON.stringify({ Version: '9.9.9.9' }),
    );
    expect(installedPluginVersion(() => join(bin, 'jetstream.js'))).toBe('9.9.9.9');
    expect(installedPluginVersion(() => null)).toBeNull();
  });

  it('--version is intercepted by the package itself: prints its version, never spawns', () => {
    const said: string[] = [];
    const spawn = vi.fn();
    runJetstream({
      args: ['--version'],
      say: (m) => said.push(m),
      resolve: () => null, // plugin not installed → package line only
      spawn: spawn as unknown as typeof spawnType,
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^@pimmesz\/jetstream \d+\.\d+\.\d+/);
    expect(spawn).not.toHaveBeenCalled();
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

  it('install --help and update --help only print help, never install or update', () => {
    for (const verb of ['install', 'update']) {
      const say = vi.fn();
      const spawn = vi.fn();
      const install = vi.fn();
      const recordDirs = vi.fn();
      runJetstream({
        args: [verb, '--help'],
        say,
        spawn: spawn as unknown as typeof spawnType,
        install,
        recordDirs,
      });
      expect(spawn, verb).not.toHaveBeenCalled();
      expect(install, verb).not.toHaveBeenCalled();
      expect(recordDirs, verb).not.toHaveBeenCalled();
      expect(String(say.mock.calls[0]?.[0]), verb).toContain(`jetstream ${verb}:`);
    }
  });

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
      recordDirs: vi.fn(),
    });
    expect(install).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled(); // never looks for an installed CLI
    expect(spawn).not.toHaveBeenCalled();
  });

  it('install records the shell dirs, and prints the note, before handing the plugin to Stream Deck', () => {
    const order: string[] = [];
    const say = vi.fn();
    runJetstream({
      args: ['install'],
      say,
      recordDirs: () => {
        order.push('record');
        return 'Recorded CLAUDE_CONFIG_DIR=/a/claude for the Stream Deck plugin';
      },
      install: () => order.push('install'),
    });
    expect(order).toEqual(['record', 'install']);
    expect(say).toHaveBeenCalledWith('Recorded CLAUDE_CONFIG_DIR=/a/claude for the Stream Deck plugin');
  });

  it('update records the shell dirs before npm i -g', () => {
    const order: string[] = [];
    const child = fakeChild();
    runJetstream({
      args: ['update'],
      recordDirs: () => {
        order.push('record');
        return undefined;
      },
      spawn: (() => {
        order.push('npm');
        return child;
      }) as unknown as typeof spawnType,
      globalRoot: () => undefined,
      install: vi.fn(),
      say: vi.fn(),
      error: vi.fn(),
      setExitCode: vi.fn(),
      platform: 'darwin',
      exists: () => false,
    });
    expect(order).toEqual(['record', 'npm']);
  });

  it('a forwarded verb leaves recording to the plugin CLI, so `doctor` stays read-only', () => {
    for (const verb of ['doctor', 'chat']) {
      const recordDirs = vi.fn();
      runJetstream({
        args: [verb],
        resolve: () => '/plugin/bin/jetstream.js',
        spawn: (() => fakeChild()) as unknown as typeof spawnType,
        recordDirs,
      });
      expect(recordDirs, verb).not.toHaveBeenCalled();
    }
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

  it('update: runs npm i -g, then hands off to the install flow on success', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const install = vi.fn();
    runJetstream({
      args: ['update'],
      recordDirs: vi.fn(),
      globalRoot: () => undefined,
      spawn: spawn as unknown as typeof spawnType,
      install,
      say: vi.fn(),
      error: vi.fn(),
      setExitCode: vi.fn(),
      platform: 'darwin',
      exists: () => false, // no npm-cli.js next to node → PATH fallback
    });
    // The registry is pinned so a machine-local mirror cannot serve a stale "latest", and
    // --prefer-online forces a fresh packument so a cached one cannot either.
    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['i', '-g', '--prefer-online', `--@pimmesz:registry=${PUBLIC_REGISTRY}`, '@pimmesz/jetstream'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(install).not.toHaveBeenCalled(); // not before npm finishes
    child.fire('exit', 0);
    expect(install).toHaveBeenCalledOnce();
  });

  it('update: a failed npm install stops the flow — no plugin handoff, non-zero exit', () => {
    const child = fakeChild();
    const install = vi.fn();
    const error = vi.fn();
    const setExitCode = vi.fn();
    runJetstream({
      args: ['update'],
      recordDirs: vi.fn(),
      globalRoot: () => undefined,
      spawn: (() => child) as unknown as typeof spawnType,
      install,
      say: vi.fn(),
      error,
      setExitCode,
      platform: 'darwin',
      exists: () => false,
    });
    child.fire('exit', 1);
    expect(install).not.toHaveBeenCalled();
    expect(error.mock.calls.at(-1)![0]).toContain('npm install failed');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('update: uses the npm.cmd shim through a shell on Windows', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    runJetstream({
      args: ['update'],
      recordDirs: vi.fn(),
      globalRoot: () => undefined,
      spawn: spawn as unknown as typeof spawnType,
      install: vi.fn(),
      say: vi.fn(),
      error: vi.fn(),
      setExitCode: vi.fn(),
      platform: 'win32',
      exists: () => false, // no npm-cli.js next to node → guarded .cmd fallback
    });
    // cwd pinned to HOME so cmd.exe's CWD-first resolution can't run a planted npm.cmd.
    expect(spawn).toHaveBeenCalledWith(
      'npm.cmd',
      ['i', '-g', '--prefer-online', `--@pimmesz:registry=${PUBLIC_REGISTRY}`, '@pimmesz/jetstream'],
      expect.objectContaining({ stdio: 'inherit', shell: true, cwd: homedir() }),
    );
  });

  it('update: prefers npm-cli.js next to node, spawned with NO shell (no binary planting)', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    runJetstream({
      args: ['update'],
      recordDirs: vi.fn(),
      globalRoot: () => undefined,
      spawn: spawn as unknown as typeof spawnType,
      install: vi.fn(),
      say: vi.fn(),
      error: vi.fn(),
      setExitCode: vi.fn(),
      platform: 'darwin',
      exists: () => true,
    });
    const expected = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expected, 'i', '-g', '--prefer-online', `--@pimmesz:registry=${PUBLIC_REGISTRY}`, '@pimmesz/jetstream'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
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
    // cmd.exe re-parses its command line, so it only ever sees the fixed basename; the folder (which
    // may hold a `&` from the user's name) goes in as the working directory.
    expect(spawn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'plugin.streamDeckPlugin'], {
      stdio: 'inherit',
      cwd: 'C:\\pkg',
    });
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

  it('after a clean open, polls /health and reports the plugin is live on the deck', async () => {
    const child = fakeChild();
    const say = vi.fn();
    const alive = vi.fn(async () => true);
    installPlugin({
      exists: () => true,
      artifactPath: '/pkg/plugin.streamDeckPlugin',
      platform: 'darwin',
      spawn: (() => child) as unknown as typeof spawnType,
      say,
      error: vi.fn(),
      setExitCode: vi.fn(),
      alive,
      sleep: async () => {},
    });
    child.fire('exit', 0);
    await vi.waitFor(() => expect(alive).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(say.mock.calls.some((c) => /live on your deck/.test(String(c[0])))).toBe(true),
    );
  });

  it('polls /health for the version it was told to expect, else for its own', async () => {
    // update hands over npm's global copy, which need not be the copy running this code.
    const probeAfterInstall = (expectedVersion?: string): ReturnType<typeof vi.fn> => {
      const child = fakeChild();
      const alive = vi.fn(async () => true);
      installPlugin({
        exists: () => true,
        artifactPath: '/pkg/plugin.streamDeckPlugin',
        platform: 'darwin',
        spawn: (() => child) as unknown as typeof spawnType,
        say: vi.fn(),
        error: vi.fn(),
        setExitCode: vi.fn(),
        alive,
        sleep: async () => {},
        ...(expectedVersion ? { expectedVersion } : {}),
      });
      child.fire('exit', 0);
      return alive;
    };
    const told = probeAfterInstall('1.1.0');
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith('1.1.0'));
    const own = probeAfterInstall();
    await vi.waitFor(() => expect(own).toHaveBeenCalledWith(packageVersion()));
  });

  it('gives an actionable hint (run doctor) when /health never comes up', async () => {
    const child = fakeChild();
    const say = vi.fn();
    const alive = vi.fn(async () => false); // never binds
    installPlugin({
      exists: () => true,
      artifactPath: '/pkg/plugin.streamDeckPlugin',
      platform: 'darwin',
      spawn: (() => child) as unknown as typeof spawnType,
      say,
      error: vi.fn(),
      setExitCode: vi.fn(),
      alive,
      sleep: async () => {}, // no real waiting
    });
    child.fire('exit', 0);
    await vi.waitFor(() =>
      expect(say.mock.calls.some((c) => /jetstream doctor/.test(String(c[0])))).toBe(true),
    );
    expect(alive).toHaveBeenCalledTimes(20); // exhausted every attempt before giving up
  });
});

describe('pluginReportsVersion (the update-over-old-plugin guard)', () => {
  // Spin a throwaway loopback /health server returning `reported`, point the probe at it via
  // JETSTREAM_PORT, and run `fn`.
  const withHealth = async (reported: string, fn: () => Promise<void>): Promise<void> => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(reported);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('JETSTREAM_PORT', String(port));
    try {
      await fn();
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((r) => server.close(() => r()));
    }
  };

  it('true when /health reports the expected version', async () => {
    await withHealth('1.4.0', async () => {
      expect(await pluginReportsVersion('1.4.0')).toBe(true);
    });
  });

  it('false when /health reports a DIFFERENT version — the old plugin still answering during update', async () => {
    await withHealth('1.3.1', async () => {
      expect(await pluginReportsVersion('1.4.0')).toBe(false);
    });
  });

  it('false when nothing is listening', async () => {
    vi.stubEnv('JETSTREAM_PORT', '1'); // nothing bound here → connection refused
    expect(await pluginReportsVersion('1.4.0', 200)).toBe(false);
    vi.unstubAllEnvs();
  });

  // A socket timeout only measures silence, so every dripped byte or 102 would restart it.
  it.each([
    [
      'an answer dripped one byte at a time',
      (res: ServerResponse) => {
        res.writeHead(200);
        return setInterval(() => res.write('1'), 50);
      },
    ],
    ['an endless 102 Processing', (res: ServerResponse) => setInterval(() => res.writeProcessing(), 50)],
  ])('gives up on %s by its deadline', async (_name, drip) => {
    const server = createServer((_req, res) => {
      const timer = drip(res);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    vi.stubEnv('JETSTREAM_PORT', String((server.address() as { port: number }).port));
    try {
      const started = Date.now();
      expect(await pluginReportsVersion('1.4.0', 300)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('resolves false (never hangs) when the plugin dies mid-response — the update-restart case', async () => {
    // 200 + a partial body, then the socket is destroyed before `end` — the response aborts.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('1.4'); // partial version, then die
      res.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('JETSTREAM_PORT', String(port));
    try {
      await expect(pluginReportsVersion('1.4.0', 500)).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('resolves false without crashing when a NON-200 response resets mid-stream', async () => {
    // The abort handlers must be attached before the statusCode early-return, or this ECONNRESET
    // is unhandled and terminates the installer.
    const server = createServer((_req, res) => {
      res.writeHead(503);
      res.write('x');
      res.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('JETSTREAM_PORT', String(port));
    try {
      await expect(pluginReportsVersion('1.4.0', 500)).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((r) => server.close(() => r()));
    }
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

describe('updatePackage', () => {
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

  /** Run updatePackage with a stubbed npm child, and return what it said. */
  const run = (
    exitCode = 0,
    env: NodeJS.ProcessEnv = {},
  ): { said: string[]; args: string[]; installed: boolean; npmEnv: NodeJS.ProcessEnv } => {
    const said: string[] = [];
    let installed = false;
    const child = fakeChild();
    const calls: unknown[][] = [];
    const spawn = vi.fn((...call: unknown[]) => {
      calls.push(call);
      return child;
    });
    updatePackage({
      spawn: spawn as unknown as typeof spawnType,
      globalRoot: () => undefined,
      env,
      say: (m) => said.push(m),
      error: (m) => said.push(m),
      setExitCode: () => {},
      install: () => (installed = true),
    });
    child.fire('exit', exitCode);
    // argv is either [npmCliJs, ...npmArgs] (node path) or the npm args alone (shim fallback).
    const args = (calls[0]?.[1] ?? []) as string[];
    const npmEnv = ((calls[0]?.[2] ?? {}) as { env?: NodeJS.ProcessEnv }).env ?? {};
    return { said, args, installed, npmEnv };
  };

  // The bug this exists for: a corporate ~/.npmrc points npm at a caching mirror whose index of
  // this package is stale, so `npm i -g` exits 0 having installed the same old version. Meanwhile
  // `jetstream doctor` asks npmjs.org directly and keeps insisting an update is available — the
  // two commands consult different registries and disagree forever.
  it('pins the public registry so a machine-local mirror cannot serve a stale version', () => {
    expect(run().npmEnv.npm_config_registry).toBe(PUBLIC_REGISTRY);
    expect(PUBLIC_REGISTRY).toBe('https://registry.npmjs.org/'); // must match package.json publishConfig
  });

  it('ALSO pins the scoped registry, which otherwise silently wins', () => {
    // Verified against real npm: with `@pimmesz:registry=<mirror>` in .npmrc, a plain
    // `--registry=https://registry.npmjs.org` is ignored for this scope — npm returned the
    // mirror's 1.6.0 instead of the public 2.0.0. Pinning only the unscoped form is defeated.
    expect(run().npmEnv['npm_config_@pimmesz:registry']).toBe(PUBLIC_REGISTRY);
  });

  it('also pins the scoped registry on argv, because zsh and dash drop its env name', () => {
    // `npm_config_@pimmesz:registry` is not a valid shell name, so an npm reached through a zsh or
    // dash script never sees it, and a stale `@pimmesz:registry` in .npmrc wins again.
    const { args } = run();
    expect(args).toContain(`--@pimmesz:registry=${PUBLIC_REGISTRY}`);
    expect(args.join(' ')).not.toContain('--registry='); // the plain key is a valid name, env is enough
  });

  it('forces a fresh packument (--prefer-online) so a cached "latest" cannot pin the old version', () => {
    // The registry pin defeats a stale mirror INDEX; --prefer-online defeats npm's on-disk cache —
    // the other half of the "update says nothing moved while doctor sees a newer one" bug.
    expect(run().args).toContain('--prefer-online');
  });

  it('JETSTREAM_REGISTRY overrides both, for a machine that can only reach a mirror', () => {
    const { npmEnv, args } = run(0, { JETSTREAM_REGISTRY: 'https://nexus.internal/npm/' });
    expect(npmEnv.npm_config_registry).toBe('https://nexus.internal/npm/');
    expect(npmEnv['npm_config_@pimmesz:registry']).toBe('https://nexus.internal/npm/');
    expect(args.join(' ')).not.toContain('registry'); // never on the command line
  });

  it('inline mirror credentials go to npm through its environment, never its command line', () => {
    const { args, npmEnv } = run(0, { JETSTREAM_REGISTRY: 'https://user:s3cret@nexus.internal/npm/' });
    expect(args.join(' ')).not.toContain('s3cret'); // argv is visible to every user via ps
    expect(args.join(' ')).not.toContain('registry'); // not even with the secret stripped
    expect(npmEnv.npm_config_registry).toBe('https://user:s3cret@nexus.internal/npm/');
    // A token as the username alone is a credential too.
    expect(run(0, { JETSTREAM_REGISTRY: 'https://npmtoken@nexus.internal/npm/' }).args.join(' ')).not.toContain('npmtoken');
  });

  it('keeps a token in the mirror path off the command line too', () => {
    // Gemfury-style URLs carry the token as a path segment, with no userinfo to detect.
    const { args, npmEnv } = run(0, { JETSTREAM_REGISTRY: 'https://npm-proxy.fury.io/s3cret/acme/' });
    expect(args.join(' ')).not.toContain('s3cret');
    expect(npmEnv['npm_config_@pimmesz:registry']).toBe('https://npm-proxy.fury.io/s3cret/acme/');
  });

  it('prints only the mirror origin, so a token in its path never reaches the terminal', () => {
    const { said } = run(0, { JETSTREAM_REGISTRY: 'https://npm-proxy.fury.io/s3cret/acme/' });
    expect(said.join('\n')).toContain('(checked https://npm-proxy.fury.io)');
    expect(said.join('\n')).not.toContain('s3cret');
  });

  it('a rejected registry with a path token is reported by origin only', () => {
    const said: string[] = [];
    resolveRegistry({ JETSTREAM_REGISTRY: 'https://npm-proxy.fury.io/s3cret/acme/;id' }, (m) => said.push(m));
    expect(said.join('\n')).toContain('(got https://npm-proxy.fury.io)');
    expect(said.join('\n')).not.toContain('s3cret');
  });

  it('drops every spelling of the registry keys before pinning them (Windows env is case-insensitive)', () => {
    const env = registryEnv('https://registry.npmjs.org/', { NPM_CONFIG_REGISTRY: 'https://stale/', 'NPM_CONFIG_@PIMMESZ:REGISTRY': 'https://stale/', PATH: '/bin' });
    expect(Object.keys(env).filter((k) => k.toLowerCase().includes('registry'))).toEqual(['npm_config_registry', 'npm_config_@pimmesz:registry']);
    expect(env.PATH).toBe('/bin');
  });

  it('never prints a rejected registry that may carry credentials', () => {
    const said: string[] = [];
    resolveRegistry({ JETSTREAM_REGISTRY: 'https//user:secret@mirror/' }, (m) => said.push(m));
    expect(said.join('\n')).not.toContain('secret');
    expect(said.join('\n')).toContain('value hidden');
  });

  it('reads the version and the plugin from where npm actually installed, not from this copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'js-npm-root-'));
    const pkg = join(root, '@pimmesz', 'jetstream');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const child = fakeChild();
    const said: string[] = [];
    let handed: string | undefined;
    let handedVersion: string | undefined;
    updatePackage({
      spawn: (() => child) as unknown as typeof spawnType,
      globalRoot: () => root,
      env: {},
      say: (m) => said.push(m),
      error: (m) => said.push(m),
      setExitCode: () => {},
      install: (d) => {
        handed = d.artifactPath;
        handedVersion = d.expectedVersion;
      },
    });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.1.0' })); // npm updated that copy
    child.fire('exit', 0);
    expect(said.join('\n')).toContain('Updated 1.0.0 → 1.1.0');
    expect(handed).toBe(join(pkg, 'assets', 'gg.pim.jetstream.streamDeckPlugin'));
    expect(handedVersion).toBe('1.1.0'); // the health check waits for the version npm installed
    // This test runs from the checkout, not from npm's copy, so the `jetstream` on PATH stays old.
    const runningRoot = dirname(dirname(bundledPluginPath()));
    expect(said.join('\n')).toContain(`npm installs into ${pkg}, but this \`jetstream\` runs from ${runningRoot}`);
  });

  it('stays quiet about where it runs when npm\'s copy is this one, through a symlink too', () => {
    const runningRoot = dirname(dirname(bundledPluginPath()));
    const root = makeTmp();
    mkdirSync(join(root, '@pimmesz'));
    symlinkSync(runningRoot, join(root, '@pimmesz', 'jetstream'), 'dir');
    const child = fakeChild();
    const said: string[] = [];
    updatePackage({
      spawn: (() => child) as unknown as typeof spawnType,
      globalRoot: () => root,
      env: {},
      say: (m) => said.push(m),
      error: (m) => said.push(m),
      setExitCode: () => {},
      install: () => {},
    });
    child.fire('exit', 0);
    expect(said.join('\n')).toContain('Already on');
    expect(said.join('\n')).not.toContain('runs from');
  });

  it('still names the stale copy on a later run, when npm had nothing newer', () => {
    // After the first update npm's copy is current, so every later run says "Already on", while
    // the `jetstream` on PATH (this checkout) stays old.
    const root = makeTmp();
    const pkg = join(root, '@pimmesz', 'jetstream');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const child = fakeChild();
    const said: string[] = [];
    updatePackage({
      spawn: (() => child) as unknown as typeof spawnType,
      globalRoot: () => root,
      env: {},
      say: (m) => said.push(m),
      error: (m) => said.push(m),
      setExitCode: () => {},
      install: () => {},
    });
    child.fire('exit', 0);
    const runningRoot = dirname(dirname(bundledPluginPath()));
    expect(said.join('\n')).toContain('Already on 9.9.9');
    expect(said.join('\n')).toContain(`npm installs into ${pkg}, but this \`jetstream\` runs from ${runningRoot}`);
  });

  it('says nothing moved when the version is unchanged, instead of claiming an update', () => {
    // packageVersion() reads this repo's real package.json both times, so before === after here —
    // exactly the no-op case. It must NOT print "Updated to X".
    const { said, installed } = run();
    const out = said.join('\n');
    expect(out).toMatch(/Already on \d+\.\d+\.\d+/);
    expect(out).toContain('(checked https://registry.npmjs.org)'); // and names WHICH registry it asked
    expect(out).not.toMatch(/Updated \d/);
    expect(installed).toBe(true); // still re-hands the plugin to Stream Deck
  });

  it('a failed npm exit reports the failure and never installs the plugin', () => {
    const { said, installed } = run(1);
    expect(said.join('\n')).toMatch(/npm install failed/);
    expect(installed).toBe(false);
  });

  it('refuses a JETSTREAM_REGISTRY carrying shell metacharacters', () => {
    // The Windows npm.cmd fallback spawns with shell:true, so this value would otherwise be
    // re-parsed by cmd.exe and run calc.exe. `new URL()` accepts it — `&` is legal in a path —
    // so parsing alone is NOT sufficient validation.
    const evil = 'https://nexus.invalid/& calc.exe &';
    const { args, said, npmEnv } = run(0, { JETSTREAM_REGISTRY: evil });
    expect(npmEnv.npm_config_registry).toBe(PUBLIC_REGISTRY); // fell back
    expect(args.join(' ')).not.toContain('calc.exe');
    expect(said.join('\n')).toMatch(/Ignoring JETSTREAM_REGISTRY/); // and said so, not silently
  });
});

describe('resolveRegistry / redactRegistry', () => {
  it('defaults to the public registry when unset or blank', () => {
    expect(resolveRegistry({})).toBe(PUBLIC_REGISTRY);
    expect(resolveRegistry({ JETSTREAM_REGISTRY: '   ' })).toBe(PUBLIC_REGISTRY);
  });

  it('accepts a normal mirror URL, with a port, a path, or credentials', () => {
    expect(resolveRegistry({ JETSTREAM_REGISTRY: 'http://nexus:8081/repository/npm-all/' })).toBe(
      'http://nexus:8081/repository/npm-all/',
    );
    expect(resolveRegistry({ JETSTREAM_REGISTRY: 'https://u:p@nexus.internal/npm/' })).toBe(
      'https://u:p@nexus.internal/npm/',
    );
  });

  it('rejects non-http schemes and shell metacharacters, reporting why', () => {
    const seen: string[] = [];
    for (const bad of ['file:///etc/passwd', 'https://h/;id', 'https://h/`id`', 'https://h/$(id)', 'not a url']) {
      expect(resolveRegistry({ JETSTREAM_REGISTRY: bad }, (m) => seen.push(m))).toBe(PUBLIC_REGISTRY);
    }
    expect(seen).toHaveLength(5); // every rejection is reported, never silent
  });

  it('rejects a percent sign — cmd.exe would expand it back into metacharacters', () => {
    // The Windows npm.cmd fallback joins these args into a shell command string, and cmd.exe
    // expands %VAR% while parsing. `%PAYLOAD%` where PAYLOAD is `x&calc.exe&` reintroduces
    // exactly the `&` the allowlist exists to exclude, so the character cannot be allowed.
    const seen: string[] = [];
    expect(
      resolveRegistry({ JETSTREAM_REGISTRY: 'https://nexus.internal/%PAYLOAD%' }, (m) => seen.push(m)),
    ).toBe(PUBLIC_REGISTRY);
    expect(seen).toHaveLength(1);
  });

  it('rejects a structurally invalid URL that the character allowlist alone would pass', () => {
    // Every character here is legal; the port is not. Passing it through would hand npm a
    // registry it cannot use and surface as npm's own error, hiding which setting caused it.
    const seen: string[] = [];
    expect(
      resolveRegistry({ JETSTREAM_REGISTRY: 'https://nexus.internal:99999/' }, (m) => seen.push(m)),
    ).toBe(PUBLIC_REGISTRY);
    expect(seen).toHaveLength(1);
  });

  it('prints only the origin of a registry URL, hiding credentials in userinfo or the path', () => {
    expect(redactRegistry('https://u:secret@nexus.internal/npm/')).toBe('https://nexus.internal');
    expect(redactRegistry('https://npm-proxy.fury.io/s3cret/acme/')).toBe('https://npm-proxy.fury.io');
    expect(redactRegistry('http://nexus:8081/repository/npm-all/')).toBe('http://nexus:8081');
    expect(redactRegistry(PUBLIC_REGISTRY)).toBe('https://registry.npmjs.org');
    // An unparseable URL (bad port) or one with no origin is exactly what the error path prints.
    expect(redactRegistry('https://u:secret@mirror:99999/')).toBe('(custom registry)');
    expect(redactRegistry('https://user:secret@tail@mirror:99999/')).toBe('(custom registry)');
    expect(redactRegistry('file:///home/me/s3cret/')).toBe('(custom registry)');
  });

});
