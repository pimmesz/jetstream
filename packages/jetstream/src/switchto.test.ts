import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { buildOpenCommand, isClaudeProcess, interruptPids, probeClaudeProcess } from './switchto';

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
  // ps must actually see it, or the guard would read false for the boring reason (no such process).
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

describe('interrupt guards (never signal a non-claude process)', () => {
  it('isClaudeProcess is false for this test runner, win32, and bad pids', () => {
    // The test runner is node/vitest, not "claude", so this must be false.
    expect(isClaudeProcess(process.pid)).toBe(false);
    expect(isClaudeProcess(2, 'win32')).toBe(false);
    expect(isClaudeProcess(-1)).toBe(false);
  });

  it('interruptPids signals nothing when no PID is a verified claude process', () => {
    expect(interruptPids([process.pid, 999999])).toBe(0);
  });

  it('rejects a live process that merely MENTIONS claude in its command line', () => {
    // Regression: the guard used to be /claude/i.test(ps_output). Under that rule any process
    // whose command line contains the substring — an editor on claude-notes.md, a checkout under
    // a path containing "claude" — was classified killable. It also SIGINTed vitest's own fork
    // worker whenever the repo sat on such a path, which reported as 12 skipped tests and 0
    // failures rather than as a failure.
    const lookalike = spawnClaudeLookalike();
    try {
      expect(isClaudeProcess(lookalike.pid)).toBe(false);
    } finally {
      lookalike.stop();
    }
  });

  it('interruptPids does not SIGINT a claude-lookalike, using the real default kill', () => {
    // No `kill` seam: the default `process.kill(pid, "SIGINT")` is exactly what must not fire, so
    // stubbing it would test the stub. The child survives iff the guard held.
    const lookalike = spawnClaudeLookalike();
    try {
      expect(interruptPids([lookalike.pid])).toBe(0);
      const still = execFileSync('ps', ['-p', String(lookalike.pid), '-o', 'command='], { encoding: 'utf8' });
      expect(still, 'the lookalike must still be alive — nothing may have signalled it').toMatch(/claude/i);
    } finally {
      lookalike.stop();
    }
  });

  it('does not re-signal a PID inside the cooldown, but still reports it as interrupting', () => {
    // Claude Code escalates a second Ctrl-C within about a second from "interrupt this turn" to
    // "end the session", and the board does not repaint until the next hook event — so a user who
    // sees nothing happen and presses again would lose their session. The repeat must not signal.
    const killed: number[] = [];
    const deps = { isClaude: () => true, kill: (pid: number) => void killed.push(pid), now: () => 1000 };
    expect(interruptPids([4242], 'darwin', deps)).toBe(1);
    expect(interruptPids([4242], 'darwin', { ...deps, now: () => 1500 })).toBe(1); // counted, not re-sent
    expect(killed).toEqual([4242]);
  });

  it('signals again once the cooldown has passed', () => {
    const killed: number[] = [];
    const deps = { isClaude: () => true, kill: (pid: number) => void killed.push(pid) };
    interruptPids([4243], 'darwin', { ...deps, now: () => 1000 });
    interruptPids([4243], 'darwin', { ...deps, now: () => 9000 });
    expect(killed).toEqual([4243, 4243]);
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
