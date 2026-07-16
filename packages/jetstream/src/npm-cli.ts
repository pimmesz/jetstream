import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `jetstream …` — the npm package's front door (bin/jetstream).
 *
 * `install` hands the packed `.streamDeckPlugin` shipped in this tarball to the Stream Deck
 * app (the "double-click", from the CLI); every other verb (`init` / `chat` / `doctor` /
 * `hooks` / `setup`) is a thin passthrough to the INSTALLED plugin's own CLI
 * (`gg.pim.jetstream.sdPlugin/bin/jetstream.js`).
 *
 * Distribution is CLI-first via npm (`npm i -g @pimmesz/jetstream` → `jetstream install`).
 * This package owns its own delivery: it was previously bundled inside @pimmesz/afterburner,
 * which coupled every Jetstream release to an afterburner release.
 *
 * Zero runtime dependencies on purpose — everything the plugin itself needs is inlined into
 * the .sdPlugin bundle at build time, so this installer only uses node builtins.
 */

/** The plugin dir Elgato installs into, per OS, and where the CLI sits inside it. */
const PLUGIN_REL = join('gg.pim.jetstream.sdPlugin', 'bin', 'jetstream.js');

/** The packed plugin shipped INSIDE this npm package (see scripts/prepack.mjs + the `files`
 * entry in package.json), so `jetstream install` works with no repo and no Marketplace. */
const BUNDLED_PLUGIN_REL = join('assets', 'gg.pim.jetstream.streamDeckPlugin');

/** Red, without pulling in a colour dependency. Every errRed call site writes to STDERR, so
 * it follows stderr's TTY (not stdout's) — piping `jetstream install 2>log` must not bury
 * escape codes in the log. NO_COLOR (the de-facto standard) disables it outright. */
export function errRed(message: string, stream: { isTTY?: boolean } = process.stderr): string {
  const fancy = Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;
  return fancy ? `\u001b[31m${message}\u001b[39m` : message;
}

/** The package root (the dir holding package.json), walked up from this module. Works both in
 * the published package (dist/npm-cli.js → root) and in a dev checkout (src/ → packages/jetstream). */
function packageRoot(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) break;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return dir;
}

/** Locate the packed `.streamDeckPlugin` shipped inside this npm package. */
export function bundledPluginPath(moduleUrl: string = import.meta.url): string {
  return join(packageRoot(moduleUrl), BUNDLED_PLUGIN_REL);
}

/** This npm package's version, read from its own package.json at runtime — so it always matches
 * the installed tarball, including CI's auto-bumped releases. 'unknown' if unreadable. */
export function packageVersion(moduleUrl: string = import.meta.url): string {
  try {
    const raw = readFileSync(join(packageRoot(moduleUrl), 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The INSTALLED plugin's manifest version, or null when the plugin isn't installed / readable.
 * The npm package and the deck plugin version independently (npm auto-bumps per release, the
 * sdPlugin manifest moves per plugin submission), so `--version` reports both. */
export function installedPluginVersion(
  resolve: () => string | null = resolveJetstreamCli,
): string | null {
  const cli = resolve();
  if (!cli) return null;
  try {
    const raw = readFileSync(join(dirname(cli), '..', 'manifest.json'), 'utf8');
    const version = (JSON.parse(raw) as { Version?: unknown }).Version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** The OS command that hands a file to its default app — the Stream Deck app registers the
 * `.streamDeckPlugin` type, so this triggers its install flow (the "double-click"). */
function openArgs(platform: NodeJS.Platform, file: string): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', file] };
  if (platform === 'darwin') return { cmd: 'open', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}

/** Resolve the installed Jetstream plugin CLI, or null if the plugin isn't installed.
 * Platform/env/home are injected so the resolver is unit-testable off the host. */
export function resolveJetstreamCli(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const roots: string[] = [];
  if (platform === 'darwin') {
    roots.push(join(home, 'Library', 'Application Support', 'com.elgato.StreamDeck', 'Plugins'));
  } else if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    if (appData) roots.push(join(appData, 'Elgato', 'StreamDeck', 'Plugins'));
  }
  for (const root of roots) {
    const candidate = join(root, PLUGIN_REL);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Everything the user typed after the `jetstream` bin name, forwarded verbatim.
 * Taken from argv (not a parser) so flags like `--tool-detail` and `--help` pass straight
 * through to the child instead of being swallowed here. */
export function forwardedArgs(argv: string[] = process.argv): string[] {
  return argv.slice(2);
}

export interface RunJetstreamDeps {
  /** Locate the installed plugin CLI (defaults to the real resolver). */
  resolve?: () => string | null;
  /** Spawn the child (defaults to the real node spawn); returns a child emitter. */
  spawn?: typeof spawn;
  /** Args to forward (defaults to those after the bin name in argv). */
  args?: string[];
  /** Error sink (defaults to console.error), injected for tests. */
  error?: (message: string) => void;
  /** Set the process exit code (defaults to writing process.exitCode), injected for tests. */
  setExitCode?: (code: number) => void;
  /** Handle the `install` verb (defaults to installPlugin); injected to test the interception. */
  install?: (deps: RunJetstreamDeps) => void;
  /** Path existence check (defaults to fs.existsSync), injected for tests. */
  exists?: (path: string) => boolean;
  /** The packed plugin artifact (defaults to bundledPluginPath()), injected for tests. */
  artifactPath?: string;
  /** Platform for choosing the open command (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Info sink (defaults to console.log), injected for tests. */
  say?: (message: string) => void;
}

/**
 * `jetstream install` — install the Stream Deck plugin packed inside this npm package by
 * handing it to the Stream Deck app. This package handles the verb itself: the plugin CLI
 * lives INSIDE the plugin, so it can't be what installs the plugin. Dependency-injected so
 * every branch is unit-testable without a real plugin file or a child process.
 */
export function installPlugin(deps: RunJetstreamDeps = {}): void {
  const exists = deps.exists ?? existsSync;
  const spawnFn = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const artifact = deps.artifactPath ?? bundledPluginPath();
  const say = deps.say ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));
  const setExitCode = deps.setExitCode ?? ((c: number) => (process.exitCode = c));

  if (!exists(artifact)) {
    error(
      errRed('The packed Jetstream plugin is missing from this install.') +
        '\nReinstall Jetstream (npm i -g @pimmesz/jetstream), then re-run `jetstream install`.',
    );
    setExitCode(1);
    return;
  }
  const { cmd, args } = openArgs(platform, artifact);
  say(
    'Opening the Jetstream plugin in Stream Deck — approve the install prompt there, then set up your\n' +
      'fleet: `jetstream init` (guided), or `jetstream chat` to build your board by describing your\n' +
      'repos + keys in plain English.',
  );
  // argv array, no shell — the artifact path is this package's own, never user input.
  const child = spawnFn(cmd, args, { stdio: 'inherit' });
  child.on('error', (err: Error) => {
    error(
      errRed(`Could not open the plugin installer: ${err.message}.`) +
        ' Is the Stream Deck app installed?',
    );
    setExitCode(1);
  });
}

/** The passthrough action, dependency-injected so its branches (plugin-not-found, spawn
 * wiring, exit-code propagation) are unit-testable without a real plugin or child. */
export function runJetstream(deps: RunJetstreamDeps = {}): void {
  const args = deps.args ?? forwardedArgs();
  // `--version` is this package's own verb: the npm package and the deck plugin version
  // independently, so report the package version plus the installed plugin's when present.
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    const say = deps.say ?? ((m: string) => console.log(m));
    say(`@pimmesz/jetstream ${packageVersion()}`);
    const plugin = installedPluginVersion(deps.resolve ?? resolveJetstreamCli);
    if (plugin) say(`plugin ${plugin} (installed)`);
    return;
  }
  // `install` is this package's own verb, not forwarded: the plugin CLI lives INSIDE the
  // plugin, so it can't be what installs the plugin. It opens the packed .streamDeckPlugin.
  if (args[0] === 'install') {
    (deps.install ?? installPlugin)(deps);
    return;
  }

  const resolve = deps.resolve ?? resolveJetstreamCli;
  const spawnFn = deps.spawn ?? spawn;
  const error = deps.error ?? ((m: string) => console.error(m));
  const setExitCode = deps.setExitCode ?? ((c: number) => (process.exitCode = c));

  const cli = resolve();
  if (!cli) {
    error(
      errRed('Jetstream plugin not found.') +
        '\nJetstream is a Stream Deck plugin. Install it with:\n' +
        '  jetstream install\n' +
        'then re-run `jetstream <command>`.',
    );
    setExitCode(1);
    return;
  }
  // argv array, no shell — the forwarded args can't be re-parsed as a command.
  const child = spawnFn(process.execPath, [cli, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => setExitCode(code ?? 1));
  child.on('error', (err: Error) => {
    error(errRed(`Could not run the Jetstream CLI: ${err.message}`));
    setExitCode(1);
  });
}
