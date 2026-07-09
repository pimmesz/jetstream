import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  checkAnthropicEnv,
  checkHooksPresent,
  checkProjectsConfig,
  checkGhForCi,
  commandOnPath,
  hasJetstreamHooks,
} from './doctor';

describe('checkAnthropicEnv', () => {
  it('ok when both keys are unset', () => {
    expect(checkAnthropicEnv({}).status).toBe('ok');
  });

  it('warns when a billing key is set', () => {
    expect(checkAnthropicEnv({ ANTHROPIC_API_KEY: 'sk-x' }).status).toBe('warn');
  });

  it('treats an empty value as unset', () => {
    expect(checkAnthropicEnv({ ANTHROPIC_AUTH_TOKEN: '  ' }).status).toBe('ok');
  });
});

describe('hasJetstreamHooks / checkHooksPresent', () => {
  const installed = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '"/usr/bin/node" "/x/bin/status-hook.js"' }] }],
    },
  };

  it('detects an installed jetstream hook by file basename', () => {
    expect(hasJetstreamHooks(installed)).toBe(true);
    expect(checkHooksPresent(JSON.stringify(installed)).status).toBe('ok');
  });

  it('warns when no jetstream hook is present', () => {
    const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } };
    expect(hasJetstreamHooks(other)).toBe(false);
    expect(checkHooksPresent(JSON.stringify(other)).status).toBe('warn');
    expect(checkHooksPresent('{}').status).toBe('warn');
  });

  it('distinguishes an absent settings file from a corrupt one', () => {
    const absent = checkHooksPresent(undefined);
    const corrupt = checkHooksPresent('{ not json');
    expect(absent.status).toBe('warn');
    expect(corrupt.status).toBe('warn');
    expect(corrupt.message).toContain('not valid JSON');
    expect(corrupt.message).not.toEqual(absent.message); // don't send the user to a fix that also fails
  });
});

describe('commandOnPath', () => {
  // Resolution keys off the PASSED env, not process.env — this is what lets the
  // in-plugin doctor augment PATH with the standard install dirs the GUI launchd
  // PATH omits. A tool only in `dir` is invisible until `dir` is on the PATH.
  it('finds a command only when its dir is on the supplied PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-path-'));
    try {
      const ext = process.platform === 'win32' ? '.CMD' : '';
      writeFileSync(join(dir, `faketool${ext}`), '');
      expect(commandOnPath('faketool', { PATH: dir })).toBe(true);
      expect(commandOnPath('faketool', { PATH: '/nonexistent-dir-xyz' })).toBe(false);
      expect(commandOnPath('faketool', {})).toBe(false); // no PATH at all
      // augmenting a PATH that lacked the dir now resolves it (the pluginDoctorIO fix)
      expect(commandOnPath('faketool', { PATH: ['/nonexistent-dir-xyz', dir].join(delimiter) })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkGhForCi', () => {
  it('ok when gh is found, warn otherwise', () => {
    expect(checkGhForCi(true).status).toBe('ok');
    expect(checkGhForCi(false).status).toBe('warn');
  });
});

describe('checkProjectsConfig', () => {
  it('ok when absent (optional)', () => {
    expect(checkProjectsConfig(undefined).status).toBe('ok');
  });

  it('ok for valid JSON', () => {
    expect(checkProjectsConfig('{"projects":[]}').status).toBe('ok');
  });

  it('warns for invalid JSON', () => {
    expect(checkProjectsConfig('{bad').status).toBe('warn');
  });
});
