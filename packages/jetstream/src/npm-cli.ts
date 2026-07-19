import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
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
  /** Plugin liveness probe for the post-install confirmation (defaults to a GET /health), injected for tests. */
  alive?: () => Promise<boolean>;
  /** Delay between liveness polls (defaults to setTimeout), injected so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** The loopback port the plugin's hook listener binds. Duplicated from server.ts's DEFAULT_PORT
 * on purpose: this zero-dependency front door must not import the plugin (which would pull the
 * whole server/plugin graph into the installer bundle). Kept in sync by the shared env override. */
const HEALTH_PORT = 41321;
const HEALTH_ATTEMPTS = 20; // ~20 × 2s ≈ 40s — long enough to cover the manual "approve" step
const HEALTH_INTERVAL_MS = 2_000;

/** GET 127.0.0.1/health and whether it reports the EXPECTED version. Inlined (not imported from
 * slot-client) to keep this front door free of any plugin import; node:http is a builtin. Requiring
 * a version MATCH — not just a 200 — is what stops `update` reporting success while an OLD plugin is
 * still answering: the old build returns its old version, so the poll waits until the new one loads. */
export function pluginReportsVersion(expected: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const port = Number(process.env.JETSTREAM_PORT) || HEALTH_PORT;
    const req = request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        // Attach the abort handlers FIRST — before the statusCode check can early-return — so a
        // response that resets mid-stream (a plugin dying, exactly the update-restart case) settles
        // false instead of throwing on an unhandled 'error'/'close'. resolve() is idempotent, so a
        // 'close' after a normal 'end' can't override the version-match result.
        res.on('error', () => resolve(false));
        res.on('close', () => resolve(false));
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 256) {
            resolve(false); // a version string is short — cap the body defensively
            req.destroy();
          }
        });
        res.on('end', () => resolve(body.trim() === expected));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** After the opener hands the plugin to Stream Deck, poll /health so the user gets a clear
 * "it's live" (or an actionable hint) instead of silence at "Opening…". `alive`/`sleep` are
 * injected so tests run without real http or real time. */
async function confirmPluginLive(
  say: (m: string) => void,
  alive: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    if (await alive()) {
      say('✓ Jetstream is live on your deck — run `jetstream chat` or `jetstream init` to set up your fleet.');
      return;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  say(
    "Still not detecting Jetstream on your deck. Approve the Stream Deck install prompt if you haven't,\n" +
      'then run `jetstream doctor` to check the connection.',
  );
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
  child.on('exit', (code) => {
    // The opener exits non-zero when no app is registered for .streamDeckPlugin — surface it
    // instead of reporting success while nothing was installed.
    if (code !== 0 && code !== null) {
      error(
        errRed(`The system opener exited with ${code}.`) + ' Is the Stream Deck app installed?',
      );
      setExitCode(code);
      return;
    }
    // Opener handed off OK. Now confirm the plugin actually comes up on the deck so the user isn't
    // left guessing after "Opening…". We wait for /health to report the version we just installed
    // (packageVersion reads it from disk — fresh after an `update`), so an old plugin still holding
    // the port can't report success before the new build loads. Fire-and-forget: the pending polls
    // keep the process alive until it resolves, then it exits on its own.
    const expected = packageVersion();
    void confirmPluginLive(say, deps.alive ?? (() => pluginReportsVersion(expected)), deps.sleep);
  });
  child.on('error', (err: Error) => {
    error(
      errRed(`Could not open the plugin installer: ${err.message}.`) +
        ' Is the Stream Deck app installed?',
    );
    setExitCode(1);
  });
}

/** `jetstream update` — `npm i -g @pimmesz/jetstream`, then the `install` flow, so ONE command
 * takes both the CLI and the deck plugin to the latest release (the README's "re-run the same
 * two commands", automated). This package owns the verb: the plugin CLI lives inside the plugin
 * and can't replace the package it ships in. */
export function updatePackage(deps: RunJetstreamDeps = {}): void {
  const spawnFn = deps.spawn ?? spawn;
  const say = deps.say ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));
  const setExitCode = deps.setExitCode ?? ((c: number) => (process.exitCode = c));
  const platform = deps.platform ?? process.platform;

  say('Updating @pimmesz/jetstream via npm…');
  const npmArgs = ['i', '-g', '@pimmesz/jetstream'];
  // Prefer npm's own JS entry next to THIS node binary, spawned with NO shell: on Windows a
  // shell resolves a bare `npm.cmd` from the CURRENT DIRECTORY before PATH, so a planted
  // npm.cmd in e.g. a cloned repo would run instead of npm (binary planting). node ships npm
  // alongside node.exe on Windows and under ../lib on unix installs.
  const exists = deps.exists ?? existsSync;
  const win = platform === 'win32';
  const nodeDir = dirname(process.execPath);
  const npmCli = win
    ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const child = exists(npmCli)
    ? spawnFn(process.execPath, [npmCli, ...npmArgs], { stdio: 'inherit' })
    : win
      ? // Fallback .cmd shim needs a shell; pin cwd to HOME so the current directory can
        // never supply the binary. The arguments are fixed literals.
        spawnFn('npm.cmd', npmArgs, { stdio: 'inherit', shell: true, cwd: homedir() })
      : spawnFn('npm', npmArgs, { stdio: 'inherit' }); // execvp PATH lookup — no CWD resolution
  child.on('exit', (code) => {
    if (code !== 0) {
      error(errRed(`npm install failed (exit ${code ?? 1}) — the plugin was not reinstalled.`));
      setExitCode(code ?? 1);
      return;
    }
    // packageVersion() reads package.json from disk, so this reports the FRESH version even
    // though this process still runs the old code; the bundled artifact on disk is new too.
    say(`Updated to ${packageVersion()} — handing the plugin to Stream Deck…`);
    (deps.install ?? installPlugin)(deps);
  });
  child.on('error', (err: Error) => {
    error(errRed(`Could not run npm: ${err.message}`));
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
  // `update` = npm i -g + the install flow, in one verb (also package-owned, same reason).
  if (args[0] === 'update') {
    updatePackage(deps);
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
