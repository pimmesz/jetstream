import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordShellDirs } from './shell-dirs';

/**
 * `jetstream …` — the npm package's front door (bin/jetstream).
 *
 * `install` hands the packed `.streamDeckPlugin` shipped in this tarball to the Stream Deck
 * app (the "double-click", from the CLI); every other verb (`init` / `chat` / `doctor` /
 * `hooks` / `setup`) is a thin passthrough to the INSTALLED plugin's own CLI
 * (`gg.pim.jetstream.sdPlugin/bin/jetstream.js`).
 *
 * Distribution is CLI-first via npm (`npm i -g @pimmesz/jetstream` → `jetstream install`).
 * This package owns its own delivery, so a Jetstream release is self-contained and independent.
 *
 * Zero runtime dependencies on purpose — everything the plugin itself needs is inlined into
 * the .sdPlugin bundle at build time, so this installer only uses node builtins.
 */

/** Where this package is published, and therefore the only registry an update can be found at.
 * `jetstream doctor` asks the same host, so its "an update is available" and this command's
 * "here it is" can never disagree because of a machine-local mirror. */
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

/** A registry URL conservative enough to be safe as a command-line argument.
 *
 * A `JETSTREAM_REGISTRY` override travels only in npm's environment (argv only ever carries the
 * npmjs.org constant), so this is defence in depth for the Windows `npm.cmd` fallback (spawn with
 * `shell: true`), where cmd.exe re-parses the joined command string. A URL is otherwise free to
 * contain `&`, so validating merely that it parses would still let
 * `https://host/& calc.exe &` execute. This pattern allows every character a real registry URL
 * needs (host, port, path, userinfo) and no cmd.exe metacharacter.
 *
 * `%` is deliberately NOT allowed, even though URLs may percent-encode. cmd.exe expands `%VAR%`
 * while parsing, so a registry containing `%FOO%` becomes whatever FOO holds — and if that is
 * `x&calc.exe&`, the expansion reintroduces the very metacharacters this pattern exists to
 * exclude. A base registry URL has no need to percent-encode, so forbidding it costs nothing. */
const SAFE_REGISTRY = /^https?:\/\/[A-Za-z0-9._~:/@+-]+$/;

/** Print only a registry's origin: a token rides in `user:password@` or, Gemfury-style, as a path
 * segment, and a terminal log or a pasted bug report must not be where either leaks. */
export function redactRegistry(url: string): string {
  try {
    const { origin } = new URL(url);
    // A non-http(s) scheme has no origin (the string 'null'), so it is named generically too.
    return origin === 'null' ? '(custom registry)' : origin;
  } catch {
    return '(custom registry)';
  }
}

/** The registry to install from: `JETSTREAM_REGISTRY` when it is a well-formed http(s) URL, else
 * the public one. A malformed value is REPORTED rather than silently ignored or passed through —
 * quietly falling back would look like the override worked, and passing it through would put an
 * unvalidated string on a command line. */
export function resolveRegistry(
  env: NodeJS.ProcessEnv = process.env,
  onInvalid: (message: string) => void = () => {},
): string {
  const raw = env.JETSTREAM_REGISTRY?.trim();
  if (!raw) return PUBLIC_REGISTRY;
  const reject = (): string => {
    // A rejected value is malformed by definition, so redaction cannot be trusted to find its
    // credentials: never print one that contains an `@`.
    const shown = raw.includes('@') ? '(value hidden: it looks like it carries credentials)' : redactRegistry(raw);
    onInvalid(`Ignoring JETSTREAM_REGISTRY: it must be a plain http(s) URL (got ${shown}). Using ${PUBLIC_REGISTRY}`);
    return PUBLIC_REGISTRY;
  };
  if (!SAFE_REGISTRY.test(raw)) return reject();
  // The character allowlist alone still passes structurally invalid URLs — `https://host:99999/`
  // is all legal characters but has an out-of-range port. npm would take it and fail with its own
  // opaque error; parsing here means the message names the variable that actually caused it.
  try {
    new URL(raw);
  } catch {
    return reject();
  }
  return raw;
}

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
function openArgs(platform: NodeJS.Platform, file: string): { cmd: string; args: string[]; cwd?: string } {
  // cmd.exe re-parses its command line, so a `&` or `%` in the install path would split it. Run from
  // the file's folder and pass only its fixed basename, as exec-terminal.ts does.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', win32.basename(file)], cwd: win32.dirname(file) };
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
  /** Environment (defaults to process.env), injected for tests. Read for JETSTREAM_REGISTRY. */
  env?: NodeJS.ProcessEnv;
  /** Info sink (defaults to console.log), injected for tests. */
  say?: (message: string) => void;
  /** Plugin health probe for the post-install confirmation, given the version to wait for (defaults to
   * pluginReportsVersion), injected for tests. */
  alive?: (expected: string) => Promise<boolean>;
  /** Delay between liveness polls (defaults to setTimeout), injected so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** npm's global node_modules (`npm root -g`), or undefined when it cannot be asked; injected for tests. */
  globalRoot?: () => string | undefined;
  /** The version the installed plugin should report on /health (update passes the one npm installed). */
  expectedVersion?: string;
  /** Record this shell's config dirs for the plugin (defaults to recordShellDirs); returns a note to print. */
  recordDirs?: () => string | undefined;
}

/** The registry always travels in npm's ENVIRONMENT, and on its argv only as the npmjs.org default: argv
 * is readable by every user on the machine (`ps`), the environment only by you. Env
 * config also outranks .npmrc for both the plain and the scoped key (verified against npm 11), which
 * is the precedence the pin needs (DECISIONS.md #10). */
export function registryEnv(registry: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ours = ['npm_config_registry', 'npm_config_@pimmesz:registry'];
  // Windows env names are case-insensitive: an inherited NPM_CONFIG_REGISTRY would survive next to ours
  // and win, so drop every spelling of these two before setting them.
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !ours.includes(k.toLowerCase())));
  return { ...env, npm_config_registry: registry, 'npm_config_@pimmesz:registry': registry };
}

/** The version in a package directory's package.json, or undefined when there is none. */
function versionAt(dir: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
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
      // A deadline for the whole request: a socket timeout only measures silence, so an endless
      // '102 Processing' or a dripped answer would hold the poll open. The abort lands in 'error'.
      { host: '127.0.0.1', port, path: '/health', method: 'GET', signal: AbortSignal.timeout(timeoutMs) },
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
  // Say that we are waiting. The preceding message ends with "then set up your fleet…", which
  // reads DONE — and then the process sits silent for up to ~40s while this polls, inviting a
  // Ctrl-C or typing into a shell that is still busy.
  say('Waiting for the plugin to come up on your deck (up to ~40s)…');
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    if (await alive()) {
      say('✓ Jetstream is live on your deck — run `jetstream chat` or `jetstream init` to set up your fleet.');
      return;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  say(
    "Still not detecting Jetstream on your deck. Approve the Stream Deck install prompt if you haven't,\n" +
      'then run `jetstream doctor` to check the connection.\n' +
      'If Stream Deck said "already installed", it kept the plugin it had: it only upgrades when the\n' +
      "manifest Version increases, so a build carrying the installed version is refused. Releases bump\n" +
      'that automatically — a hand-built plugin does not.',
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
  const { cmd, args, cwd } = openArgs(platform, artifact);
  say(
    'Opening the Jetstream plugin in Stream Deck — approve the install prompt there, then set up your\n' +
      'fleet: `jetstream init` (guided), or `jetstream chat` to build your board by describing your\n' +
      'repos + keys in plain English.',
  );
  // argv array, no shell on macOS and Linux; on Windows cmd.exe only ever sees the fixed basename.
  const child = spawnFn(cmd, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
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
    // The version the handed-over plugin will report: the copy npm installed when update says so.
    const expected = deps.expectedVersion ?? packageVersion();
    const alive = deps.alive ?? pluginReportsVersion;
    void confirmPluginLive(say, () => alive(expected), deps.sleep);
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
  // Pin the registry this package is actually published to, matching package.json's
  // `publishConfig`. Without it npm uses whatever the machine's ~/.npmrc points at — on a
  // corporate laptop that is often a caching mirror whose index of this package is months stale.
  // npm then installs "the newest it knows", exits 0, and leaves you on the old version, while
  // `jetstream doctor` (which asks npmjs.org directly) insists an update is available. The two
  // commands must consult the same registry or they disagree forever.
  //
  // BOTH forms are needed: for a scoped package a `@pimmesz:registry` line in .npmrc takes
  // PRECEDENCE over the plain registry, so pinning only the latter is silently defeated.
  // `JETSTREAM_REGISTRY` is the escape hatch for a machine that legitimately cannot reach
  // npmjs.org and updates through an authorized mirror instead. It is still validated (a strict
  // URL allowlist, no `%`, see SAFE_REGISTRY), even though it travels only in the environment.
  const registry = resolveRegistry(deps.env ?? process.env, (m) => error(errRed(m)));
  const npmEnv = registryEnv(registry, deps.env ?? process.env);
  const npmArgs = [
    'i',
    '-g',
    // Force a fresh packument read. The registry pin defeats a stale MIRROR index, but not
    // npm's own on-disk cache: a cached "latest" can reinstall the same old version, exit 0, and
    // leave this command reporting "nothing newer" while `jetstream doctor` (a direct GET, no
    // cache) already sees the new one. That is the exact disagreement the two commands must avoid.
    '--prefer-online',
    // zsh and dash drop `npm_config_@pimmesz:registry` (not a valid shell name) when npm is a script
    // shim, so the default pin also goes on argv. A JETSTREAM_REGISTRY mirror stays env-only: it can
    // carry a token in its userinfo or its path, and argv shows in `ps`.
    ...(registry === PUBLIC_REGISTRY ? [`--@pimmesz:registry=${PUBLIC_REGISTRY}`] : []),
    '@pimmesz/jetstream',
  ];
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
  const hasNpmCli = exists(npmCli);
  // npm installs into ITS global prefix, which need not be where this running copy lives (Homebrew
  // node against a /usr/local install, npx). So the version check and the plugin handed to Stream
  // Deck come from npm's own global root, not from this module (DECISIONS.md #9).
  const globalRoot =
    deps.globalRoot ??
    ((): string | undefined => {
      try {
        const out = hasNpmCli
          ? execFileSync(process.execPath, [npmCli, 'root', '-g'], { encoding: 'utf8', env: npmEnv, timeout: 15_000 })
          : win
            ? execFileSync('npm.cmd', ['root', '-g'], { encoding: 'utf8', env: npmEnv, timeout: 15_000, shell: true, cwd: homedir() })
            : execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env: npmEnv, timeout: 15_000 });
        return out.trim() || undefined;
      } catch {
        return undefined;
      }
    });
  const installedDir = (): string | undefined => {
    const root = globalRoot();
    const dir = root ? join(root, '@pimmesz', 'jetstream') : undefined;
    return dir && versionAt(dir) !== undefined ? dir : undefined;
  };
  const versionNow = (): string => {
    const dir = installedDir();
    return (dir && versionAt(dir)) ?? packageVersion();
  };
  const before = versionNow();
  const child = hasNpmCli
    ? spawnFn(process.execPath, [npmCli, ...npmArgs], { stdio: 'inherit', env: npmEnv })
    : win
      ? // Fallback .cmd shim needs a shell; pin cwd to HOME so the current directory can never supply
        // the binary. Every argument is a fixed literal; a JETSTREAM_REGISTRY override rides in the environment.
        spawnFn('npm.cmd', npmArgs, { stdio: 'inherit', shell: true, cwd: homedir(), env: npmEnv })
      : spawnFn('npm', npmArgs, { stdio: 'inherit', env: npmEnv }); // execvp PATH lookup, no CWD resolution
  child.on('exit', (code) => {
    if (code !== 0) {
      error(errRed(`npm install failed (exit ${code ?? 1}) — the plugin was not reinstalled.`));
      setExitCode(code ?? 1);
      return;
    }
    // Read from npm's global install on disk: the FRESH version even though this process still runs
    // the old code, and the copy npm actually updated.
    const dir = installedDir();
    const after = (dir && versionAt(dir)) ?? packageVersion();
    if (after === before) {
      // npm exited 0 but nothing moved. Say so rather than claiming an update: a silent no-op is
      // exactly how a stale mirror wastes an afternoon. Already-latest is the benign case, so
      // name both possibilities instead of guessing which one this is.
      say(`Already on ${after} — npm had nothing newer to install.`);
      say(`  (checked ${redactRegistry(registry)})`);
    } else {
      say(`Updated ${before} → ${after} — handing the plugin to Stream Deck…`);
    }
    // A `jetstream` that runs from outside npm's global root (pnpm -g, Volta, npx) never moves, and
    // its own `install` would hand Stream Deck the old plugin, so say which copy to remove.
    const running = packageRoot(import.meta.url);
    if (dir && realpathSync(dir) !== realpathSync(running)) {
      say(`Note: npm installs into ${dir}, but this \`jetstream\` runs from ${running}; remove that copy or put npm's global bin first on PATH.`);
    }
    (deps.install ?? installPlugin)(
      dir ? { ...deps, artifactPath: join(dir, BUNDLED_PLUGIN_REL), expectedVersion: after } : deps,
    );
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
  // `install` and `update` change the machine, so asking either for help must only print help.
  if ((args[0] === 'install' || args[0] === 'update') && args.some((a) => a === '--help' || a === '-h')) {
    const say = deps.say ?? ((m: string) => console.log(m));
    say(
      args[0] === 'install'
        ? 'jetstream install: hand the packed plugin to the Stream Deck app (approve its prompt). Takes no options.'
        : 'jetstream update: npm i -g @pimmesz/jetstream from the public registry (JETSTREAM_REGISTRY overrides it),\nthen reinstall the plugin. Takes no options.',
    );
    return;
  }
  // Both verbs (re)start the plugin, which reads the recorded CLAUDE_CONFIG_DIR and CODEX_HOME only
  // as it starts, so record this shell's first.
  if (args[0] === 'install' || args[0] === 'update') {
    const note = (deps.recordDirs ?? recordShellDirs)();
    if (note) (deps.say ?? ((m: string) => console.log(m)))(note);
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
