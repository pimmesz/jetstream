import { describe, it, expect } from 'vitest';
import { isClaudeCommand, parseClaudeProcs, parseLsofCwd, discoverClaudeSessions } from './discover';

describe('isClaudeCommand', () => {
  it('matches the claude executable / a claude-code script, not claude as an argument', () => {
    expect(isClaudeCommand('claude --dangerously-skip-permissions')).toBe(true); // bin/shim
    expect(isClaudeCommand('/usr/local/bin/claude chat')).toBe(true); // absolute bin
    expect(isClaudeCommand('node /Users/me/.local/bin/claude chat')).toBe(true); // node script
    expect(isClaudeCommand('node /opt/claude-code/dist/cli.js')).toBe(true); // claude-code install
    // NOT a claude session — `claude` is just an argument to another command:
    expect(isClaudeCommand('rg claude src')).toBe(false);
    expect(isClaudeCommand('vim /repo/claude.md')).toBe(false);
    expect(isClaudeCommand('grep -r claude .')).toBe(false);
    expect(isClaudeCommand('/bin/zsh -c echo claudexyz')).toBe(false);
  });
});

describe('parseClaudeProcs', () => {
  it('picks Claude CLI pids + %cpu, skipping the app, plugin, hooks, and claude-as-argument', () => {
    const ps = [
      '  501 30.9 claude --dangerously-skip-permissions /effort',
      ' 1234  0.1 node /Users/me/.local/bin/claude chat',
      '  777  3.0 node /opt/claude-code/dist/cli.js', // node-run claude-code install
      ' 2222 10.0 /Applications/Claude.app/Contents/MacOS/Claude', // desktop app
      ' 3333  5.0 node /Users/me/Library/.../gg.pim.jetstream.sdPlugin/bin/plugin.js', // this plugin
      ' 4444  2.0 node /Users/me/.../gg.pim.jetstream.sdPlugin/bin/status-hook.js', // a hook
      ' 999 12.0 rg claude src', // `claude` is a search arg, NOT a session
      ' 888  8.0 vim /repo/claude.md', // editing a file named claude.md, NOT a session
      '    1  0.0 /sbin/launchd',
    ].join('\n');
    expect(parseClaudeProcs(ps)).toEqual([
      { pid: 501, cpu: 30.9 },
      { pid: 1234, cpu: 0.1 },
      { pid: 777, cpu: 3.0 },
    ]);
  });
});

describe('parseLsofCwd', () => {
  it('maps each pid to its cwd from `lsof -Fn` output', () => {
    const m = parseLsofCwd('p501\nn/Users/me/falcon\np1234\nn/Users/me/api\n');
    expect(m.get(501)).toBe('/Users/me/falcon');
    expect(m.get(1234)).toBe('/Users/me/api');
    expect(m.size).toBe(2);
  });
});

describe('discoverClaudeSessions', () => {
  it('joins ps procs with lsof cwds and marks a CPU-burning session active, an idle one not', async () => {
    const exec = async (cmd: string): Promise<string> => {
      if (cmd === 'ps') return '  501 30.9 claude\n 1234  0.1 claude chat\n';
      if (cmd === 'lsof') return 'p501\nn/Users/me/falcon\np1234\nn/Users/me/api\n';
      return '';
    };
    expect(await discoverClaudeSessions(exec)).toEqual([
      { pid: 501, cwd: '/Users/me/falcon', active: true }, // 30.9% → working
      { pid: 1234, cwd: '/Users/me/api', active: false }, // 0.1% → idle
    ]);
  });

  it('drops a pid whose cwd lsof could not resolve', async () => {
    const exec = async (cmd: string): Promise<string> =>
      cmd === 'ps' ? '  501 20.0 claude\n 1234 15.0 claude\n' : 'p501\nn/Users/me/falcon\n';
    expect(await discoverClaudeSessions(exec)).toEqual([
      { pid: 501, cwd: '/Users/me/falcon', active: true },
    ]);
  });

  it('returns [] when no Claude sessions run', async () => {
    expect(await discoverClaudeSessions(async () => '    1  0.0 /sbin/launchd\n')).toEqual([]);
  });
});
