import { describe, it, expect } from 'vitest';
import { execPlan } from './slot-exec';

describe('execPlan', () => {
  it('opens an app via the platform opener — path as one literal argv element', () => {
    expect(execPlan({ kind: 'app', app: '/Applications/Telegram.app' }, 'darwin')).toEqual({
      cmd: 'open',
      args: ['/Applications/Telegram.app'],
    });
    expect(execPlan({ kind: 'app', app: 'C:\\Apps\\x.exe' }, 'win32')).toEqual({
      cmd: 'explorer',
      args: ['C:\\Apps\\x.exe'],
    });
    expect(execPlan({ kind: 'app', app: '/opt/x' }, 'linux')).toEqual({ cmd: 'xdg-open', args: ['/opt/x'] });
  });

  it('rejects a flag-like app target (isSafeAppTarget guard) so the opener never gets an option', () => {
    expect(execPlan({ kind: 'app', app: '-a' }, 'darwin')).toBeNull();
  });

  it('opens only http(s) URLs', () => {
    expect(execPlan({ kind: 'url', url: 'https://github.com' }, 'darwin')).toEqual({
      cmd: 'open',
      args: ['https://github.com'],
    });
    expect(execPlan({ kind: 'url', url: 'file:///etc/passwd' }, 'darwin')).toBeNull();
    expect(execPlan({ kind: 'url', url: 'javascript:alert(1)' }, 'darwin')).toBeNull();
  });

  it('runs a command with a literal argv — shell metacharacters never split into new args', () => {
    const plan = execPlan(
      { kind: 'run', command: 'git', args: ['commit', '-m', 'a; rm -rf ~ && echo pwned'], cwd: '/repo' },
      'darwin',
    );
    expect(plan).toEqual({ cmd: 'git', args: ['commit', '-m', 'a; rm -rf ~ && echo pwned'], cwd: '/repo' });
    expect(plan?.args).toHaveLength(3); // the dangerous string stays ONE element, never re-parsed
  });

  it('is null for an empty slot or a missing target', () => {
    expect(execPlan({ kind: 'empty' })).toBeNull();
    expect(execPlan({})).toBeNull();
    expect(execPlan({ kind: 'app' })).toBeNull();
    expect(execPlan({ kind: 'run' })).toBeNull();
  });
});
