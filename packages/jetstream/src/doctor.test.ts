import { describe, it, expect } from 'vitest';
import {
  checkAnthropicEnv,
  checkHooksPresent,
  checkProjectsConfig,
  checkGhForCi,
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
