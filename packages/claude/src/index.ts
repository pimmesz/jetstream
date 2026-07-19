import { spawn } from 'node:child_process';

export interface LaunchOptions {
  /** The prompt (or `/skill args`). Sent on STDIN, never as an argv the shell parses. */
  prompt: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  cwd?: string;
  appendSystemPrompt?: string;
  continueSession?: boolean;
  resume?: string;
  fork?: boolean;
}

/** Build the `claude` argv for a one-shot streaming run. The PROMPT is deliberately
 * NOT included — it goes on stdin (safe for untrusted/long prompts; nothing the shell
 * ever parses). Pure. */
export function buildArgs(opts: LaunchOptions): string[] {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.continueSession) args.push('--continue');
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.fork) args.push('--fork-session');
  return args;
}

/** A copy of `env` with API/token credentials removed, so a headless run spends the
 * subscription and can't silently bill the metered per-token API. Both
 * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` can outrank the subscription login,
 * so both are stripped. Pure. */
export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean.ANTHROPIC_API_KEY;
  delete clean.ANTHROPIC_AUTH_TOKEN;
  return clean;
}

export type ClaudeEvent =
  | { type: 'text'; text: string }
  | { type: 'result'; sessionId?: string; result?: string; costUsd?: number; isError: boolean }
  | { type: 'other'; raw: unknown };

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Best-effort assistant-text extraction. The exact stream-json schema varies by
 * Claude version (see SPEC open items) — verify in PHASE 2. */
function extractText(event: Record<string, unknown>): string | undefined {
  const message = event.message;
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  return texts.length > 0 ? texts.join('') : undefined;
}

/** Parse one line of `--output-format stream-json` output into a typed event, or null
 * for a blank/unparseable line. Output is untrusted → defensive. The `result` event
 * (session id, final text, cost, error) is fully handled; assistant text is best-
 * effort; everything else passes through as `other`. Pure. */
export function parseStreamLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  if (event.type === 'result') {
    return {
      type: 'result',
      sessionId: str(event.session_id),
      result: str(event.result),
      costUsd: num(event.total_cost_usd),
      isError: event.is_error === true,
    };
  }
  const text = extractText(event);
  return text !== undefined ? { type: 'text', text } : { type: 'other', raw: parsed };
}

export interface RunResult {
  sessionId?: string;
  result?: string;
  isError: boolean;
  exitCode: number | null;
  /** Total USD the run cost, from the result event (headless runs report this). */
  costUsd?: number;
}

/** The minimal child-process surface `runClaude` needs — injectable so tests never
 * spawn a real `claude`. */
export interface SpawnLike {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  stdin: { end(data?: string): void };
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  /** Terminate a wedged run (the watchdog). Node's `ChildProcess.kill` matches this shape. */
  kill(signal?: NodeJS.Signals): void;
}

export interface RunDeps {
  spawnFn?: (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => SpawnLike;
  env?: NodeJS.ProcessEnv;
  /** Watchdog ceiling (ms) — a run past this is killed and resolves an error. Injectable for tests. */
  timeoutMs?: number;
}

/** A headless run must never hang the key forever. Generous (a real launch can run many minutes)
 * but bounded, so a wedged `claude` can't pin the key or leak a quota-burning orphan indefinitely. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
/** Grace between SIGTERM and the harder SIGKILL, for a child that ignores the polite signal. */
const KILL_GRACE_MS = 5_000;

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): SpawnLike {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as SpawnLike;
}

/** Run `claude -p` once, streaming typed events to `onEvent`, resolving with the final
 * result (session id, text, error, exit code). Strips the API key; writes the prompt
 * to stdin. `spawnFn` is injectable for tests. Never rejects — a spawn/`error` event, OR a
 * run that exceeds `deps.timeoutMs` (default 20 min, at which point the child is killed),
 * resolves as `{ isError: true }`. */
export function runClaude(
  opts: LaunchOptions,
  onEvent: (event: ClaudeEvent) => void,
  deps: RunDeps = {},
): Promise<RunResult> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let killGrace: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult): void => {
      if (settled) return; // the watchdog and a real close/error can race — first one wins
      settled = true;
      resolve(result);
    };
    const clearTimers = (): void => {
      if (watchdog) clearTimeout(watchdog);
      if (killGrace) clearTimeout(killGrace);
      watchdog = undefined;
      killGrace = undefined;
    };

    let child: SpawnLike;
    try {
      child = spawnFn('claude', buildArgs(opts), {
        cwd: opts.cwd,
        env: sanitizeEnv(deps.env ?? process.env),
      });
    } catch {
      finish({ isError: true, exitCode: null });
      return;
    }

    let buffer = '';
    let final: RunResult = { isError: false, exitCode: null };
    const consume = (line: string): void => {
      const event = parseStreamLine(line);
      if (!event) return;
      onEvent(event);
      if (event.type === 'result') {
        final = {
          isError: event.isError,
          exitCode: null,
          sessionId: event.sessionId,
          result: event.result,
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        };
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        consume(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    });
    child.on('error', () => {
      clearTimers();
      finish({ isError: true, exitCode: null });
    });
    child.on('close', (code) => {
      clearTimers(); // the run ended on its own — cancel the watchdog (and any pending SIGKILL)
      consume(buffer); // flush a trailing partial line
      finish({
        ...final,
        exitCode: code,
        isError: final.isError || (typeof code === 'number' && code !== 0),
      });
    });

    // Watchdog: resolve as an error the moment the run overruns (unblock the key now), then
    // terminate the orphan — SIGTERM, escalating to SIGKILL if it ignores the polite signal.
    watchdog = setTimeout(() => {
      watchdog = undefined;
      finish({ isError: true, exitCode: null });
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      killGrace = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, KILL_GRACE_MS);
      killGrace.unref?.();
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    watchdog.unref?.();

    child.stdin.end(opts.prompt);
  });
}
