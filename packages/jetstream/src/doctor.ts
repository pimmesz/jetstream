import { existsSync, readFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettingsPath } from './hooks-install';
import { projectsConfigPath } from './projects-config';
import { pluginAlive } from './slot-client';
import { PLUGIN_VERSION } from './server';
import { readBoardLayout, type BoardLayout } from './board-layout';
import { coordLabel } from './actions/coord';
import { ENFORCE_TOKEN, listenerTokenPath, readToken, tokenIsPrivate } from './listener-token';

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
/** Is OUR usage statusline hook the configured statusline? Pure — `raw` is the settings file text.
 * Shared with the Usage key so a blank gauge can tell "not wired" from "wired, no data yet". */
export function usageStatuslineWired(raw: string | undefined): boolean {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return false;
  }
  const statusLine = asRecord(asRecord(parsed)?.statusLine);
  // Require type:'command' so this agrees with mergeHooks' own "is it ours?" test — without it
  // doctor could report the gauge wired while the installer still treats the slot as foreign and
  // refuses to wire it, leaving a green check over a permanently blank key.
  return (
    statusLine?.type === 'command' &&
    typeof statusLine.command === 'string' &&
    statusLine.command.includes('usage-hook.js')
  );
}

export function checkUsageStatusline(raw: string | undefined): CheckResult {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (usageStatuslineWired(raw)) {
    return { status: 'ok', message: 'usage gauge statusline (usage-hook.js) wired' };
  }
  if (parsed !== undefined && hasJetstreamHooks(parsed)) {
    // A foreign statusline is kept unless you consent to replacing it, so plain `hooks install`
    // deliberately leaves the gauge dark. Name the two routes that DO take the slot — the
    // inspector's Fix button (the press is the consent) keeps its fixId.
    if (asRecord(parsed)?.statusLine !== undefined) {
      return {
        status: 'warn',
        message:
          'another statusline is configured, so the usage gauge is not wired and the Usage key stays blank — press Fix, or run `jetstream hooks install --replace-statusline`',
        fixId: 'hooks',
      };
    }
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

/**
 * Keys pointing at an action this build no longer declares.
 *
 * When a release DROPS an action (CI / Launch / Model went in v2.0.0), Stream Deck keeps the key
 * on your profile — it has no idea the action is gone, and deleting keys for an unresolvable
 * action would let one failed plugin load wipe a layout. So the key stays as a blank square that
 * does nothing. `checkBoardKeys` can't see it either: the UUID still starts with
 * `gg.pim.jetstream.`, so it counts as healthy.
 *
 * Detection only. Nothing here can delete the key — no plugin can (the SDK has no create/delete
 * API for keys), which is precisely why this needs to be SAID rather than silently repaired.
 */
export function checkOrphanedKeys(board: BoardLayout | null, declared: string[]): CheckResult {
  // No board, or no manifest to compare against → nothing verifiable; stay quiet rather than
  // guess. (An empty `declared` would otherwise flag every key on the deck.)
  if (board === null || declared.length === 0) {
    return { status: 'ok', message: 'no keys pointing at removed actions' };
  }
  const known = new Set(declared);
  const isOrphan = (uuid: string): boolean => uuid.startsWith('gg.pim.jetstream.') && !known.has(uuid);

  // Coordinates come from the visible board, so the message can point at a key you can see.
  const orphaned: string[] = [];
  for (const [coord, key] of board.keys) {
    if (!isOrphan(key.uuid)) continue;
    const [cs, rs] = coord.split(',');
    orphaned.push(coordLabel(Number(cs), Number(rs)));
  }
  // …but count across EVERY page. `keys` keeps only the first page's key per coordinate, so a dead
  // key on page 2 hiding behind a live one on page 1 would otherwise go unreported entirely.
  const totalOrphans = board.allUuids.filter(isOrphan).length;
  if (totalOrphans === 0) {
    return { status: 'ok', message: 'no keys pointing at removed actions' };
  }
  // Name coordinates when we have them; when the only orphans are on other pages we can still say
  // they exist, which beats silence.
  const where = orphaned.length > 0 ? ` (${orphaned.join(', ')})` : ' on another page of this profile';
  const hidden = totalOrphans - orphaned.length;
  const alsoHidden = hidden > 0 && orphaned.length > 0 ? ` — plus ${hidden} on another page` : '';
  return {
    status: 'warn',
    message:
      `${totalOrphans} key(s) point at actions this version removed${where}${alsoHidden} — ` +
      'they do nothing. Delete them in Stream Deck, or run `jetstream chat` and ask for an empty slot there.',
  };
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
  settingsRaw: () => string | undefined;
  projectsRaw: () => string | undefined;
  /** Is the plugin's hook listener answering on the loopback port? Injected for tests. */
  listenerAlive: () => Promise<boolean>;
  /** The detected Jetstream board (or null when none), for the "no keys placed" check. Injected for tests. */
  boardLayout: () => BoardLayout | null;
  /** The latest published npm version (null when the registry can't be reached). Injected for tests. */
  latestVersion: () => Promise<string | null>;
  /** Whether the loopback token exists and is owner-only. Injected for tests. */
  listenerToken: () => { present: boolean; private: boolean };
  /** The action UUIDs THIS build declares, read from its own manifest — the yardstick for
   * spotting keys left pointing at an action a release removed. Empty when unreadable, which
   * makes the check stay silent rather than flag every key. Injected for tests. */
  declaredActions: () => string[];
}

/** Where the manifest sits relative to THIS module, in both shapes it runs in: bundled into the
 * plugin's `bin/` (manifest is one level up) and straight from `src/` in a dev checkout or a test
 * (manifest is under the sdPlugin dir). Getting this wrong is silent — the check would just never
 * fire — so try both rather than assume the deployment. */
function manifestCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, '..', 'manifest.json'),
    join(here, '..', 'gg.pim.jetstream.sdPlugin', 'manifest.json'),
  ];
}

/** The action UUIDs in the plugin's own manifest.json — the first candidate path that yields any.
 * [] when none can be read. Never throws: an unreadable manifest must degrade to "can't tell",
 * not break `doctor`. */
export function readDeclaredActions(...paths: string[]): string[] {
  for (const manifestPath of paths) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { Actions?: unknown };
      if (!Array.isArray(parsed.Actions)) continue;
      const uuids = parsed.Actions.map((a) => (a as { UUID?: unknown }).UUID).filter(
        (u): u is string => typeof u === 'string',
      );
      if (uuids.length > 0) return uuids;
    } catch {
      // next candidate
    }
  }
  return [];
}

export function defaultDoctorIO(): DoctorIO {
  return {
    env: process.env,
    claudeOnPath: () => commandOnPath('claude'),
    settingsRaw: () => readIfPresent(defaultSettingsPath()),
    projectsRaw: () => readIfPresent(projectsConfigPath()),
    listenerAlive: () => pluginAlive(),
    boardLayout: () => readBoardLayout(),
    latestVersion: () => fetchLatestVersion(),
    listenerToken: () => ({ present: readToken() !== undefined, private: tokenIsPrivate() }),
    declaredActions: () => readDeclaredActions(...manifestCandidates()),
  };
}

/**
 * The loopback listener answers hook events, permission decisions, and live board edits, so
 * anything that can reach 127.0.0.1:41321 can drive your deck. It is authenticated by a shared
 * token — but for two releases an untokened request is still accepted, so hooks installed by an
 * older Jetstream keep working. Warn for that whole window: while it is open, the token is a
 * speed bump, not a gate.
 */
export function checkListenerToken(token: { present: boolean; private: boolean }): CheckResult {
  if (!token.present) {
    return {
      status: 'warn',
      message:
        'no loopback token — any local process can drive your board. Start the Stream Deck app once with Jetstream installed to generate one.',
    };
  }
  if (!token.private) {
    return {
      status: 'warn',
      message: `loopback token is readable by other users — run \`chmod 600 ${listenerTokenPath()}\``,
    };
  }
  // NOT a warning. During the grace period this state is expected and nothing the user does can
  // clear it — the flag flips in a later release. Reporting it as a warning meant doctor
  // permanently showed a "problem" with a prescribed command (`jetstream hooks install`) that
  // could not change the outcome, which is exactly the trap the usage-statusline check fell into:
  // a diagnostic must never hand you an action that leaves it saying the same thing.
  return ENFORCE_TOKEN
    ? { status: 'ok', message: 'loopback token required on every hook and board edit' }
    : {
        status: 'ok',
        message:
          'loopback token in place (untokened requests still accepted during the upgrade grace period — no action needed)',
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
    ? {
        status: 'warn',
        // Name the registry. This check asks npmjs.org directly, so if the machine's npm points at
        // a stale mirror, plain `npm i -g` can "succeed" without moving the version and this
        // warning would repeat forever with no explanation. `jetstream update` pins the same
        // registry, which is why it is the command to run.
        message: `${installed} installed — ${latest} is available on npmjs.org; run \`jetstream update\` (it pins the public registry; a bare \`npm i -g\` may hit a stale mirror)`,
      }
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
  const board = io.boardLayout(); // read once, shared by the key-count + orphaned-key checks
  // The two async probes (loopback listener + npm registry) run in parallel so doctor isn't serial.
  const [listener, latest] = await Promise.all([io.listenerAlive(), io.latestVersion()]);
  return [
    checkClaudeOnPath(io.claudeOnPath()),
    checkAnthropicEnv(io.env),
    checkHooksPresent(settings),
    checkUsageStatusline(settings),
    checkProjectsConfig(io.projectsRaw()),
    checkBoardKeys(board),
    checkOrphanedKeys(board, io.declaredActions()),
    checkListener(listener),
    checkListenerToken(io.listenerToken()),
    checkLatestVersion(PLUGIN_VERSION, latest),
  ];
}

/** Render check results as `✓` / `⚠` lines. */
export function formatReport(results: CheckResult[]): string {
  return results.map((r) => `${r.status === 'ok' ? '✓' : '⚠'} ${r.message}`).join('\n');
}
