import { existsSync, readFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { delimiter, join } from 'node:path';
import { defaultSettingsPath } from './hooks-install';
import { projectsConfigPath } from './projects-config';
import { pluginAlive } from './slot-client';
import { PLUGIN_VERSION } from './server';
import { readBoardLayout, type BoardLayout } from './board-layout';

/**
 * `jetstream doctor` — the read-only answer to "why isn't my board lighting up?". Every
 * check reports `✓` / `⚠`, never mutates anything, and the command always exits 0. The
 * pure check functions take their inputs so they're unit-testable without touching the
 * real machine; the IO that gathers those inputs lives in `defaultDoctorIO`.
 */

export type CheckStatus = 'ok' | 'warn';

export interface CheckResult {
  status: CheckStatus;
  message: string;
  /** When a warning has an in-app fix, the id the Settings inspector acts on: 'hooks'
   * dispatches to the backend installer, 'fleet' focuses the add-repo field (client-side).
   * Absent = no one-press fix. */
  fixId?: 'hooks' | 'fleet';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The bundled hook scripts the installer wires into settings.json. The presence check
 * matches on these basenames, NOT the exact command string — that embeds an absolute node
 * path + install location that differs per machine, so an exact match would nearly always
 * fail after the plugin is installed somewhere new. */
const JETSTREAM_HOOK_FILES = ['status-hook.js', 'permission-hook.js', 'usage-hook.js'];

/** Whether a parsed `~/.claude/settings.json` contains any Jetstream hook command. Pure. */
export function hasJetstreamHooks(settings: unknown): boolean {
  const root = asRecord(settings);
  if (!root) return false;
  const commands: string[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const hooks = asRecord(entry)?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        const command = asRecord(hook)?.command;
        if (typeof command === 'string') commands.push(command);
      }
    }
  };
  const hooks = asRecord(root.hooks);
  if (hooks) for (const value of Object.values(hooks)) collect(value);
  const statusLine = asRecord(root.statusLine)?.command;
  if (typeof statusLine === 'string') commands.push(statusLine);
  return commands.some((command) => JETSTREAM_HOOK_FILES.some((file) => command.includes(file)));
}

/** `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` should be UNSET — set, they'd bill the
 * metered API instead of drawing the subscription (the exact concern `claude.sanitizeEnv`
 * strips for). Pure. */
export function checkAnthropicEnv(env: NodeJS.ProcessEnv): CheckResult {
  const set = (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const).filter(
    (name) => (env[name] ?? '').trim() !== '',
  );
  if (set.length === 0) {
    return {
      status: 'ok',
      message: 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN unset — Claude draws your subscription',
    };
  }
  return {
    status: 'warn',
    message: `${set.join(' and ')} set — Claude would bill the metered API instead of your subscription; unset ${
      set.length > 1 ? 'them' : 'it'
    }`,
  };
}

/** Whether Jetstream's hooks are installed, given the RAW `~/.claude/settings.json` string
 * (`undefined` when the file is absent). Distinguishes absent, present-but-corrupt, and
 * valid — so a corrupt settings.json isn't misreported as "hooks not found" (which would
 * send the user to `hooks install`, where the same parse then fails). Pure. */
export function checkHooksPresent(raw: string | undefined): CheckResult {
  if (raw === undefined) {
    return {
      status: 'warn',
      message: 'no ~/.claude/settings.json — run `jetstream hooks install`',
      fixId: 'hooks',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // NOT auto-fixable: installing over a corrupt settings.json would fail the same parse.
    return {
      status: 'warn',
      message: '~/.claude/settings.json is present but not valid JSON — fix or remove it',
    };
  }
  return hasJetstreamHooks(parsed)
    ? { status: 'ok', message: 'Jetstream hooks present in ~/.claude/settings.json' }
    : { status: 'warn', message: 'Jetstream hooks not found — run `jetstream hooks install`', fixId: 'hooks' };
}

/** The usage gauge draws from the statusLine hook (`usage-hook.js`) — a SEPARATE wire from the
 * status/permission hooks. `hasJetstreamHooks` matches ANY Jetstream hook basename, so a board
 * with status+permission wired but no usage statusLine passes that check while the Usage key stays
 * blank. Flag exactly that gap. Stays quiet when settings are absent/corrupt or Jetstream isn't set
 * up at all — `checkHooksPresent` already leads the way there. Pure. */
export function checkUsageStatusline(raw: string | undefined): CheckResult {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const command = asRecord(asRecord(parsed)?.statusLine)?.command;
  if (typeof command === 'string' && command.includes('usage-hook.js')) {
    return { status: 'ok', message: 'usage gauge statusline (usage-hook.js) wired' };
  }
  if (parsed !== undefined && hasJetstreamHooks(parsed)) {
    return {
      status: 'warn',
      message:
        'usage gauge statusline (usage-hook.js) not wired — the Usage key stays blank; run `jetstream hooks install`',
      fixId: 'hooks',
    };
  }
  return { status: 'ok', message: 'usage gauge statusline wires when you install the hooks' };
}

/** doctor confirms hooks + a bound listener but never that a Jetstream key is actually PLACED —
 * the first-run "why isn't anything lighting up?" case is often just an empty board. Count the
 * Jetstream keys on the detected board. Pure. */
export function checkBoardKeys(board: BoardLayout | null): CheckResult {
  if (board === null) {
    return {
      status: 'warn',
      message: 'no Jetstream board detected — drag a Fleet + Attention key onto your deck, or run `jetstream init`',
      fixId: 'fleet',
    };
  }
  let count = 0;
  for (const key of board.keys.values()) {
    if (key.uuid.startsWith('gg.pim.jetstream.')) count++;
  }
  if (count === 0) {
    return {
      status: 'warn',
      message: `"${board.profileName}" has no Jetstream keys — drag a Fleet/Attention/Project key on, or run \`jetstream chat\``,
      fixId: 'fleet',
    };
  }
  return { status: 'ok', message: `${count} Jetstream key(s) on "${board.profileName}"` };
}

/** Whether `projects.json` (if present) is parseable. `undefined` means the file is absent,
 * which is fine — it's optional. Pure. */
export function checkProjectsConfig(raw: string | undefined): CheckResult {
  if (raw === undefined) {
    return { status: 'ok', message: 'no projects.json (optional) — projects come from placed keys' };
  }
  try {
    JSON.parse(raw);
  } catch {
    return { status: 'warn', message: 'projects.json is not valid JSON — the plugin will ignore it' };
  }
  return { status: 'ok', message: 'projects.json is valid JSON' };
}

/** Whether the `claude` CLI was found on PATH. Pure. */
export function checkClaudeOnPath(found: boolean): CheckResult {
  return found
    ? { status: 'ok', message: 'claude found on PATH' }
    : {
        status: 'warn',
        message: 'claude not found on PATH — install Claude Code and log in (`claude` → `/login`)',
      };
}

/** Whether the `gh` CLI was found on PATH — needed by the CI/PR status key. Pure. */
export function checkGhForCi(found: boolean): CheckResult {
  return found
    ? { status: 'ok', message: 'gh found on PATH (for the CI/PR status key)' }
    : {
        status: 'warn',
        message:
          'gh not found on PATH — the CI/PR status key needs it (`gh auth login`); other keys work without it',
      };
}

/** Best-effort probe for an executable on PATH. Cross-platform (honours PATHEXT on
 * Windows) and NEVER throws — doctor must always exit 0. */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue === '') return false;
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, command + ext))) return true;
      } catch {
        // ignore an unreadable PATH entry
      }
    }
  }
  return false;
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The side-effecting inputs each check needs, gathered in one place so `runDoctor` stays
 * pure given an injected IO (the tests inject; the CLI uses `defaultDoctorIO`). */
export interface DoctorIO {
  env: NodeJS.ProcessEnv;
  claudeOnPath: () => boolean;
  ghOnPath: () => boolean;
  settingsRaw: () => string | undefined;
  projectsRaw: () => string | undefined;
  /** Is the plugin's hook listener answering on the loopback port? Injected for tests. */
  listenerAlive: () => Promise<boolean>;
  /** The detected Jetstream board (or null when none), for the "no keys placed" check. Injected for tests. */
  boardLayout: () => BoardLayout | null;
  /** The latest published npm version (null when the registry can't be reached). Injected for tests. */
  latestVersion: () => Promise<string | null>;
}

export function defaultDoctorIO(): DoctorIO {
  return {
    env: process.env,
    claudeOnPath: () => commandOnPath('claude'),
    ghOnPath: () => commandOnPath('gh'),
    settingsRaw: () => readIfPresent(defaultSettingsPath()),
    projectsRaw: () => readIfPresent(projectsConfigPath()),
    listenerAlive: () => pluginAlive(),
    boardLayout: () => readBoardLayout(),
    latestVersion: () => fetchLatestVersion(),
  };
}

/** The plugin can be installed + hooks wired yet the board still dark because its listener never
 * bound (e.g. an orphaned prior process held the port). Probe it so doctor stops reporting all-green
 * on a dark board. */
function checkListener(alive: boolean): CheckResult {
  return alive
    ? { status: 'ok', message: 'plugin hook listener responding on 127.0.0.1:41321' }
    : {
        status: 'warn',
        message:
          'plugin hook listener NOT responding on 127.0.0.1:41321 — the board will not update. Is the Stream Deck app running with Jetstream installed? (restart it if so.)',
      };
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Is version `a` newer than `b`? Both are numeric `X.Y.Z` (CI's release gate enforces that). */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Whether a newer @pimmesz/jetstream is published. Best-effort: `latest` is null when the registry
 * couldn't be reached (offline / timeout), so this NEVER warns without a definite answer and doctor
 * still exits clean on a plane. Compares the npm PACKAGE version (baked into the build), which is
 * what `jetstream update` bumps — not the independent sdPlugin manifest version. Pure. */
export function checkLatestVersion(installed: string, latest: string | null): CheckResult {
  if (latest === null || !SEMVER.test(installed) || !SEMVER.test(latest)) {
    return { status: 'ok', message: `version ${installed}` }; // no definite comparison → just report it
  }
  return isNewerVersion(latest, installed)
    ? { status: 'warn', message: `${installed} installed — ${latest} is available; run \`jetstream update\`` }
    : { status: 'ok', message: `on the latest version (${installed})` };
}

/** The latest published @pimmesz/jetstream version from the npm registry, or null on ANY failure
 * (offline, timeout, non-200, parse) — so the version check stays strictly best-effort and doctor
 * exits clean with no network. A short timeout keeps `doctor` snappy; the response listeners settle
 * null on an abort so a mid-stream reset can't hang or throw (the same care as slot-client/npm-cli). */
function fetchLatestVersion(timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsGet(
      { host: 'registry.npmjs.org', path: '/@pimmesz/jetstream/latest', timeout: timeoutMs, headers: { accept: 'application/json' } },
      (res) => {
        res.on('error', () => resolve(null));
        res.on('close', () => resolve(null));
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) {
            resolve(null); // a manifest is small — cap defensively
            req.destroy();
          }
        });
        res.on('end', () => {
          try {
            const v = (JSON.parse(body) as { version?: unknown }).version;
            resolve(typeof v === 'string' ? v : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Run every read-only check. Never mutates, never throws. */
export async function runDoctor(io: DoctorIO = defaultDoctorIO()): Promise<CheckResult[]> {
  const settings = io.settingsRaw(); // read once, shared by the hooks + usage-statusline checks
  // The two async probes (loopback listener + npm registry) run in parallel so doctor isn't serial.
  const [listener, latest] = await Promise.all([io.listenerAlive(), io.latestVersion()]);
  return [
    checkClaudeOnPath(io.claudeOnPath()),
    checkAnthropicEnv(io.env),
    checkHooksPresent(settings),
    checkUsageStatusline(settings),
    checkProjectsConfig(io.projectsRaw()),
    checkBoardKeys(io.boardLayout()),
    checkGhForCi(io.ghOnPath()),
    checkListener(listener),
    checkLatestVersion(PLUGIN_VERSION, latest),
  ];
}

/** Render check results as `✓` / `⚠` lines. */
export function formatReport(results: CheckResult[]): string {
  return results.map((r) => `${r.status === 'ok' ? '✓' : '⚠'} ${r.message}`).join('\n');
}
