import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { buildOpenCommand, probeClaudeProcess } from './switchto';

/**
 * A REAL live process whose `ps` command line contains the substring "claude" while not being the
 * Claude CLI — a path token like `/tmp/claude-notes.md`, the exact case the strict classifier
 * exists to reject. Driving `ps` for real is the point: a stubbed classifier cannot catch a guard
 * that has gone loose. Returns the pid plus a stop().
 */
function spawnClaudeLookalike(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '/tmp/claude-notes.md'], {
    stdio: 'ignore',
  });
  const pid = child.pid as number;
  // ps must actually see it, or the probe would read 'dead' for the boring reason (no such process).
  const deadline = Date.now() + 5000;
  let seen = '';
  while (Date.now() < deadline) {
    try {
      seen = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (/claude/i.test(seen)) break;
    } catch {
      /* not visible yet */
    }
  }
  expect(seen, 'ps must show the lookalike with "claude" in its command line').toMatch(/claude/i);
  return { pid, stop: () => void child.kill('SIGKILL') };
}

describe('probeClaudeProcess uses the strict classifier', () => {
  it('reads a live process that merely MENTIONS claude as not a Claude session', () => {
    const lookalike = spawnClaudeLookalike();
    try {
      expect(probeClaudeProcess(lookalike.pid)).toBe('dead');
    } finally {
      lookalike.stop();
    }
  });
});

describe('buildOpenCommand — open the project folder, no terminal, no claude', () => {
  it('macOS: opens the folder in the first present editor app via `open -a`', () => {
    const cmd = buildOpenCommand('/Users/me/proj', 'darwin', { appExists: (a) => a === 'Cursor' });
    expect(cmd).toEqual({ cmd: 'open', args: ['-a', 'Cursor', '/Users/me/proj'] });
  });

  it('macOS: prefers VS Code when both it and Cursor are present', () => {
    const cmd = buildOpenCommand('/Users/me/proj', 'darwin', { appExists: () => true });
    expect(cmd).toEqual({ cmd: 'open', args: ['-a', 'Visual Studio Code', '/Users/me/proj'] });
  });

  it('macOS: falls back to Finder (`open <path>`) when no editor app is installed', () => {
    const cmd = buildOpenCommand('/Users/me/proj', 'darwin', { appExists: () => false });
    expect(cmd).toEqual({ cmd: 'open', args: ['/Users/me/proj'] });
  });

  it('macOS: never launches claude and never runs a shell', () => {
    const cmd = buildOpenCommand(`/Users/me/o'brien "x"`, 'darwin', { appExists: () => false });
    expect(cmd.cmd).toBe('open'); // not osascript / Terminal
    expect(cmd.args.join(' ')).not.toContain('claude');
    // argv array: the path is a discrete arg, never spliced into a shell string.
    expect(cmd.args.at(-1)).toBe(`/Users/me/o'brien "x"`);
  });

  it('Linux/Windows: opens in a CLI editor on PATH, else $EDITOR, else the OS opener', () => {
    expect(buildOpenCommand('/x', 'linux', { onPath: (c) => c === 'code' })).toEqual({
      cmd: 'code',
      args: ['/x'],
    });
    expect(buildOpenCommand('/x', 'linux', { onPath: () => false, editor: 'nvim' })).toEqual({
      cmd: 'nvim',
      args: ['/x'],
    });
    // $EDITOR may carry flags — the executable must stay just the command, flags go before the path.
    expect(buildOpenCommand('/x', 'linux', { onPath: () => false, editor: 'code --wait' })).toEqual({
      cmd: 'code',
      args: ['--wait', '/x'],
    });
    expect(buildOpenCommand('/x', 'linux', { onPath: () => false, editor: '' })).toEqual({
      cmd: 'xdg-open',
      args: ['/x'],
    });
    expect(buildOpenCommand('C:\\proj', 'win32', { onPath: () => false, editor: '' })).toEqual({
      cmd: 'explorer',
      args: ['C:\\proj'],
    });
  });
});

describe('probeClaudeProcess (conclusive dead vs inconclusive unknown, for the reaper)', () => {
  it("reports 'dead' for a live non-Claude process (this runner) — the pid moved on / was reused", () => {
    // ps runs (exit 0) and the command isn't claude → the Claude session that had this pid is gone.
    expect(probeClaudeProcess(process.pid)).toBe('dead');
  });

  it("reports 'dead' for an absent pid (ps exits 1 = no such process)", () => {
    expect(probeClaudeProcess(999999)).toBe('dead');
  });

  it("reports 'unknown' on win32 and for bad pids — never a false 'dead'", () => {
    expect(probeClaudeProcess(2, 'win32')).toBe('unknown');
    expect(probeClaudeProcess(-1)).toBe('unknown');
    expect(probeClaudeProcess(1)).toBe('unknown');
  });
});
