import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import {
  buildArgs,
  sanitizeEnv,
  parseStreamLine,
  runClaude,
  type SpawnLike,
  type ClaudeEvent,
  type RunDeps,
} from './index';

describe('buildArgs', () => {
  it('never puts the prompt in argv (it goes on stdin)', () => {
    const args = buildArgs({ prompt: 'malicious; rm -rf ~', model: 'claude-opus-4-8' });
    expect(args).not.toContain('malicious; rm -rf ~');
  });

  it('builds the full flag set in order', () => {
    expect(
      buildArgs({
        prompt: 'x',
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        allowedTools: ['Read', 'Grep'],
        appendSystemPrompt: 'be terse',
      }),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-4-8',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Read,Grep',
      '--append-system-prompt',
      'be terse',
    ]);
  });

  it('adds continue / resume / fork', () => {
    expect(buildArgs({ prompt: 'x', continueSession: true })).toContain('--continue');
    expect(buildArgs({ prompt: 'x', resume: 'sess-1' })).toEqual(
      expect.arrayContaining(['--resume', 'sess-1']),
    );
    expect(buildArgs({ prompt: 'x', fork: true })).toContain('--fork-session');
  });
});

describe('sanitizeEnv', () => {
  it('strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, keeps the subscription token', () => {
    const clean = sanitizeEnv({
      ANTHROPIC_API_KEY: 'sk-should-be-gone',
      ANTHROPIC_AUTH_TOKEN: 'also-metered-gone',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      PATH: '/usr/bin',
    });
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(clean.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(clean.PATH).toBe('/usr/bin');
  });
});

describe('parseStreamLine', () => {
  it('parses the result event', () => {
    expect(
      parseStreamLine(
        JSON.stringify({
          type: 'result',
          session_id: 's1',
          result: 'done',
          is_error: false,
          total_cost_usd: 0.02,
        }),
      ),
    ).toEqual({ type: 'result', sessionId: 's1', result: 'done', costUsd: 0.02, isError: false });
  });

  it('carries is_error:true through to the result event', () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: 'result', session_id: 's1', result: 'boom', is_error: true }),
      ),
    ).toEqual({
      type: 'result',
      sessionId: 's1',
      result: 'boom',
      costUsd: undefined,
      isError: true,
    });
  });

  it('passes missing/mistyped result fields through as undefined', () => {
    // absent entirely
    expect(parseStreamLine(JSON.stringify({ type: 'result' }))).toEqual({
      type: 'result',
      sessionId: undefined,
      result: undefined,
      costUsd: undefined,
      isError: false,
    });
    // wrong types (str/num reject non-string/non-finite values)
    expect(
      parseStreamLine(
        JSON.stringify({ type: 'result', session_id: 42, result: null, total_cost_usd: 'free' }),
      ),
    ).toEqual({
      type: 'result',
      sessionId: undefined,
      result: undefined,
      costUsd: undefined,
      isError: false,
    });
  });

  it('joins only the text blocks of mixed assistant content', () => {
    expect(
      parseStreamLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'tool_use', name: 'Bash' },
              { type: 'text', text: 'b' },
              'junk',
              42,
              { type: 'text', text: 7 }, // text field must be a string
            ],
          },
        }),
      ),
    ).toEqual({ type: 'text', text: 'ab' });
  });

  it('falls through to `other` when no usable text exists (non-text blocks, absent/non-array content)', () => {
    const cases: unknown[] = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'assistant', message: {} },
      { type: 'assistant', message: { content: 'not an array' } },
      { type: 'assistant', message: 'not an object' },
      { type: 'assistant' },
    ];
    for (const raw of cases) {
      expect(parseStreamLine(JSON.stringify(raw))).toEqual({ type: 'other', raw });
    }
  });

  it('extracts assistant text, passes other events through, rejects junk', () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } }),
      ),
    ).toEqual({ type: 'text', text: 'yo' });
    expect(parseStreamLine(JSON.stringify({ type: 'system', foo: 1 }))).toEqual({
      type: 'other',
      raw: { type: 'system', foo: 1 },
    });
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('not json')).toBeNull();
    expect(parseStreamLine('42')).toBeNull();
  });
});

/** A fake child that emits the given stdout lines then a close code, so runClaude is
 * exercised without spawning a real `claude`. */
function fakeSpawn(
  lines: string[],
  exitCode: number | null,
): { spawnFn: RunDeps['spawnFn']; fire: () => void; fail: (err: Error) => void } {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  const child = {
    stdout,
    stdin: { end() {} },
    on: proc.on.bind(proc),
  } as unknown as SpawnLike;
  const fire = (): void => {
    for (const line of lines) stdout.emit('data', `${line}\n`);
    proc.emit('close', exitCode);
  };
  const fail = (err: Error): void => {
    proc.emit('error', err);
  };
  return { spawnFn: () => child, fire, fail };
}

describe('runClaude', () => {
  it('streams events and resolves with the result', async () => {
    const { spawnFn, fire } = fakeSpawn(
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({ type: 'result', session_id: 'abc', result: 'ok', is_error: false }),
      ],
      0,
    );
    const events: ClaudeEvent[] = [];
    const pending = runClaude({ prompt: 'x' }, (e) => events.push(e), { spawnFn, env: {} });
    fire();
    const result = await pending;
    expect(events.some((e) => e.type === 'text' && e.text === 'hi')).toBe(true);
    expect(result).toEqual({ sessionId: 'abc', result: 'ok', isError: false, exitCode: 0 });
  });

  it('carries costUsd from the result event when present', async () => {
    const { spawnFn, fire } = fakeSpawn(
      [JSON.stringify({ type: 'result', session_id: 'c', result: 'r', is_error: false, total_cost_usd: 0.0234 })],
      0,
    );
    const pending = runClaude({ prompt: 'x' }, () => {}, { spawnFn, env: {} });
    fire();
    expect((await pending).costUsd).toBe(0.0234);
  });

  it('marks isError on a non-zero exit even without a result event', async () => {
    const { spawnFn, fire } = fakeSpawn([], 1);
    const pending = runClaude({ prompt: 'x' }, () => {}, { spawnFn, env: {} });
    fire();
    expect((await pending).isError).toBe(true);
  });

  // The money guard at the SPAWN boundary: sanitizeEnv is unit-tested above, but that alone can't
  // prove runClaude actually hands the child a sanitized env — capture what spawnFn receives.
  // Drop the sanitizeEnv() call in runClaude and this test fails; without it, a leaked
  // ANTHROPIC_API_KEY would silently bill the metered API on every chat turn.
  it('spawns claude with API-key credentials stripped from the child env, and exactly buildArgs', async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter();
    const child = { stdout, stdin: { end() {} }, on: proc.on.bind(proc) } as unknown as SpawnLike;
    let captured: { command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } } | undefined;
    const spawnFn: RunDeps['spawnFn'] = (command, args, options) => {
      captured = { command, args, options };
      return child;
    };
    const opts = { prompt: 'x', model: 'sonnet', appendSystemPrompt: 'sys' };
    const pending = runClaude(opts, () => {}, {
      spawnFn,
      env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'ok', PATH: '/usr/bin' },
    });
    proc.emit('close', 0);
    await pending;
    // Neither metered-API credential reaches the child...
    expect(captured?.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured?.options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // ...while the subscription login + PATH survive.
    expect(captured?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('ok');
    expect(captured?.options.env?.PATH).toBe('/usr/bin');
    // And the launch argv is exactly the buildArgs contract — no drift.
    expect(captured?.command).toBe('claude');
    expect(captured?.args).toEqual(buildArgs(opts));
  });

  it('handles a result split across stdout chunks (line buffering)', async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter();
    const child = { stdout, stdin: { end() {} }, on: proc.on.bind(proc) } as unknown as SpawnLike;
    const pending = runClaude({ prompt: 'x' }, () => {}, { spawnFn: () => child, env: {} });
    const line = JSON.stringify({ type: 'result', session_id: 'z', result: 'r', is_error: false });
    stdout.emit('data', line.slice(0, 10));
    stdout.emit('data', `${line.slice(10)}\n`);
    proc.emit('close', 0);
    expect((await pending).sessionId).toBe('z');
  });

  it("resolves { isError: true } on a child 'error' event — never rejects", async () => {
    const { spawnFn, fail } = fakeSpawn([], 0);
    const pending = runClaude({ prompt: 'x' }, () => {}, { spawnFn, env: {} });
    fail(new Error('spawn claude ENOENT'));
    await expect(pending).resolves.toEqual({ isError: true, exitCode: null });
  });

  it('resolves { isError: true } when spawnFn itself throws — never rejects', async () => {
    const spawnFn: RunDeps['spawnFn'] = () => {
      throw new Error('EACCES');
    };
    await expect(runClaude({ prompt: 'x' }, () => {}, { spawnFn, env: {} })).resolves.toEqual({
      isError: true,
      exitCode: null,
    });
  });

  it('kills a wedged run at the timeout and resolves isError (never a bricked key or orphan)', async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter();
    const kills: string[] = [];
    // A child that never closes on its own — SIGTERM then makes it exit shortly after (async, as
    // a real signal delivery does), so the watchdog's SIGKILL grace timer is cancelled.
    const child = {
      stdout,
      stdin: { end() {} },
      on: proc.on.bind(proc),
      kill: (sig?: string) => {
        kills.push(sig ?? 'SIGTERM');
        setTimeout(() => proc.emit('close', null), 0);
      },
    } as unknown as SpawnLike;
    const result = await runClaude({ prompt: 'x' }, () => {}, {
      spawnFn: () => child,
      env: {},
      timeoutMs: 5,
    });
    expect(result).toEqual({ isError: true, exitCode: null });
    await new Promise((r) => setTimeout(r, 5)); // let the post-SIGTERM close land
    expect(kills).toEqual(['SIGTERM']); // SIGTERM sufficed — SIGKILL never needed
  });

  it('does not kill a run that finishes before the timeout', async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter();
    const kills: string[] = [];
    const child = {
      stdout,
      stdin: { end() {} },
      on: proc.on.bind(proc),
      kill: (sig?: string) => kills.push(sig ?? 'SIGTERM'),
    } as unknown as SpawnLike;
    const pending = runClaude({ prompt: 'x' }, () => {}, {
      spawnFn: () => child,
      env: {},
      timeoutMs: 10_000,
    });
    stdout.emit('data', `${JSON.stringify({ type: 'result', result: 'r', is_error: false })}\n`);
    proc.emit('close', 0);
    expect((await pending).isError).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(kills).toEqual([]); // the watchdog was cleared on close — nothing killed
  });
});
