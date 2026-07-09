import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { defaultSettingsPath } from './hooks-install';
import { projectsConfigPath } from './projects-config';

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
}

export function defaultDoctorIO(): DoctorIO {
  return {
    env: process.env,
    claudeOnPath: () => commandOnPath('claude'),
    ghOnPath: () => commandOnPath('gh'),
    settingsRaw: () => readIfPresent(defaultSettingsPath()),
    projectsRaw: () => readIfPresent(projectsConfigPath()),
  };
}

/** Run every read-only check. Never mutates, never throws. */
export function runDoctor(io: DoctorIO = defaultDoctorIO()): CheckResult[] {
  return [
    checkClaudeOnPath(io.claudeOnPath()),
    checkAnthropicEnv(io.env),
    checkHooksPresent(io.settingsRaw()),
    checkProjectsConfig(io.projectsRaw()),
    checkGhForCi(io.ghOnPath()),
  ];
}

/** Render check results as `✓` / `⚠` lines. */
export function formatReport(results: CheckResult[]): string {
  return results.map((r) => `${r.status === 'ok' ? '✓' : '⚠'} ${r.message}`).join('\n');
}
