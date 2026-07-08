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
): { spawnFn: RunDeps['spawnFn']; fire: () => void } {
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
  return { spawnFn: () => child, fire };
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
});
