import type { spawn as spawnType } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

  it('update: runs npm i -g, then hands off to the install flow on success', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const install = vi.fn();
    runJetstream({
      args: ['update'],
      spawn: spawn as unknown as typeof spawnType,
      install,
      say: vi.fn(),
      error: vi.fn(),
      setExitCode: vi.fn(),
      platform: 'darwin',
      exists: () => false, // no npm-cli.js next to node → PATH fallback
    });
    // The registry is pinned so a machine-local mirror cannot serve a stale "latest".
    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['i', '-g', `--registry=${PUBLIC_REGISTRY}`, `--@pimmesz:registry=${PUBLIC_REGISTRY}`, '@pimmesz/jetstream'],
      { stdio: 'inherit' },
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
      ['i', '-g', `--registry=${PUBLIC_REGISTRY}`, `--@pimmesz:registry=${PUBLIC_REGISTRY}`, '@pimmesz/jetstream'],
      { stdio: 'inherit', shell: true, cwd: homedir() },
    );
  });

  it('update: prefers npm-cli.js next to node, spawned with NO shell (no binary planting)', () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    runJetstream({
      args: ['update'],
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
      [expected, 'i', '-g', `--registry=${PUBLIC_REGISTRY}`, `--@pimmesz:registry=${PUBLIC_REGISTRY}`, '@pimmesz/jetstream'],
      { stdio: 'inherit' },
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
  ): { said: string[]; args: string[]; installed: boolean } => {
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
      env,
      say: (m) => said.push(m),
      error: (m) => said.push(m),
      setExitCode: () => {},
      install: () => (installed = true),
    });
    child.fire('exit', exitCode);
    // argv is either [npmCliJs, ...npmArgs] (node path) or the npm args alone (shim fallback).
    const args = (calls[0]?.[1] ?? []) as string[];
    return { said, args, installed };
  };

  // The bug this exists for: a corporate ~/.npmrc points npm at a caching mirror whose index of
  // this package is stale, so `npm i -g` exits 0 having installed the same old version. Meanwhile
  // `jetstream doctor` asks npmjs.org directly and keeps insisting an update is available — the
  // two commands consult different registries and disagree forever.
  it('pins the public registry so a machine-local mirror cannot serve a stale version', () => {
    expect(run().args).toContain(`--registry=${PUBLIC_REGISTRY}`);
    expect(PUBLIC_REGISTRY).toBe('https://registry.npmjs.org/'); // must match package.json publishConfig
  });

  it('ALSO pins the scoped registry, which otherwise silently wins', () => {
    // Verified against real npm: with `@pimmesz:registry=<mirror>` in .npmrc, a plain
    // `--registry=https://registry.npmjs.org` is ignored for this scope — npm returned the
    // mirror's 1.6.0 instead of the public 2.0.0. Pinning only the unscoped form is defeated.
    expect(run().args).toContain(`--@pimmesz:registry=${PUBLIC_REGISTRY}`);
  });

  it('JETSTREAM_REGISTRY overrides both, for a machine that can only reach a mirror', () => {
    const args = run(0, { JETSTREAM_REGISTRY: 'https://nexus.internal/npm/' }).args;
    expect(args).toContain('--registry=https://nexus.internal/npm/');
    expect(args).toContain('--@pimmesz:registry=https://nexus.internal/npm/');
    expect(args).not.toContain(`--registry=${PUBLIC_REGISTRY}`);
  });

  it('says nothing moved when the version is unchanged, instead of claiming an update', () => {
    // packageVersion() reads this repo's real package.json both times, so before === after here —
    // exactly the no-op case. It must NOT print "Updated to X".
    const { said, installed } = run();
    const out = said.join('\n');
    expect(out).toMatch(/Already on \d+\.\d+\.\d+/);
    expect(out).toContain(PUBLIC_REGISTRY); // and names WHICH registry it asked
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
    const { args, said } = run(0, { JETSTREAM_REGISTRY: evil });
    expect(args).toContain(`--registry=${PUBLIC_REGISTRY}`); // fell back
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

  it('hides credentials when a registry URL is printed', () => {
    expect(redactRegistry('https://u:secret@nexus.internal/npm/')).not.toContain('secret');
    expect(redactRegistry('https://u:secret@nexus.internal/npm/')).toContain('credentials hidden');
    expect(redactRegistry(PUBLIC_REGISTRY)).toBe(PUBLIC_REGISTRY); // untouched when there are none
  });

});
