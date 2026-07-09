import { describe, it, expect } from 'vitest';
import { parsePermissionRequest, permissionDecisionJson, summarizeTool } from './permission';

describe('summarizeTool', () => {
  it('appends the most useful input detail', () => {
    expect(summarizeTool('Bash', { command: 'npm test' })).toBe('Bash: npm test');
    expect(summarizeTool('Edit', { file_path: '/a/b.ts' })).toBe('Edit: /a/b.ts');
    expect(summarizeTool('WebFetch', { url: 'https://x' })).toBe('WebFetch: https://x');
    expect(summarizeTool('Task', {})).toBe('Task');
  });

  it('falls back to a bare `path` input when file_path is absent', () => {
    expect(summarizeTool('Glob', { path: '/a/dir' })).toBe('Glob: /a/dir');
  });
});

describe('parsePermissionRequest', () => {
  it('parses a PermissionRequest payload', () => {
    expect(
      parsePermissionRequest(
        {
          hook_event_name: 'PermissionRequest',
          session_id: 's1',
          cwd: '/Users/me/proj',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf build' },
        },
        'perm-1',
      ),
    ).toEqual({
      id: 'perm-1',
      sessionId: 's1',
      cwd: '/Users/me/proj',
      toolName: 'Bash',
      summary: 'Bash: rm -rf build',
    });
  });

  it('returns null without a cwd (nothing to route it to)', () => {
    expect(parsePermissionRequest({ tool_name: 'Bash' }, 'x')).toBeNull();
    expect(parsePermissionRequest(null, 'x')).toBeNull();
  });

  it('defaults a missing tool_name to "tool" and a missing session_id to ""', () => {
    expect(parsePermissionRequest({ cwd: '/Users/me/proj' }, 'perm-2')).toEqual({
      id: 'perm-2',
      sessionId: '',
      cwd: '/Users/me/proj',
      toolName: 'tool',
      summary: 'tool',
    });
  });
});

describe('permissionDecisionJson', () => {
  it('emits the exact hookSpecificOutput contract', () => {
    expect(JSON.parse(permissionDecisionJson('allow'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(JSON.parse(permissionDecisionJson('deny')).hookSpecificOutput.decision.behavior).toBe(
      'deny',
    );
  });
});
