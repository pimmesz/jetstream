import { describe, it, expect } from 'vitest';
import {
  shellQuote,
  appleScriptQuote,
  buildOpenCommand,
  isClaudeProcess,
  interruptPids,
} from './switchto';

describe('shellQuote', () => {
  it('single-quotes and survives embedded quotes', () => {
    expect(shellQuote('/Users/me/proj')).toBe(`'/Users/me/proj'`);
    expect(shellQuote(`/Users/me/o'brien`)).toBe(`'/Users/me/o'\\''brien'`);
  });
});

describe('appleScriptQuote', () => {
  it('escapes backslashes and double quotes', () => {
    expect(appleScriptQuote('say "hi" \\ there')).toBe('say \\"hi\\" \\\\ there');
  });
});

describe('buildOpenCommand', () => {
  it('builds a Terminal osascript on macOS with the path safely quoted', () => {
    const cmd = buildOpenCommand(`/Users/me/o'brien "x"`, 'darwin');
    expect(cmd?.cmd).toBe('osascript');
    const script = cmd?.args.at(-1) ?? '';
    expect(script).toContain('claude --continue');
    // The path's double quotes must be AppleScript-escaped so the literal stays intact.
    expect(script).toContain('\\"x\\"');
    // And single-quoted for the shell, with the shell-quote backslash itself
    // AppleScript-escaped (\\ in the script source → \ when AppleScript runs it).
    expect(script).toContain(String.raw`o'\\''brien`);
  });

  it('builds a cmd start on Windows and null elsewhere', () => {
    expect(buildOpenCommand('C:\\proj', 'win32')?.cmd).toBe('cmd');
    expect(buildOpenCommand('/x', 'linux')).toBeNull();
  });

  it('refuses an unquotable Windows path rather than risk a cmd break-out', () => {
    expect(buildOpenCommand('C:\\a" & calc', 'win32')).toBeNull();
    expect(buildOpenCommand('C:\\a & b', 'win32')).toBeNull();
    expect(buildOpenCommand('C:\\%USERPROFILE%\\p', 'win32')).toBeNull();
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
