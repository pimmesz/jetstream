import { describe, it, expect } from 'vitest';
import { buildOpenCommand, isClaudeProcess, interruptPids } from './switchto';

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
});
