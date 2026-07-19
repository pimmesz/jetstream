import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  checkAnthropicEnv,
  checkBoardKeys,
  checkHooksPresent,
  checkProjectsConfig,
  checkGhForCi,
  checkUsageStatusline,
  commandOnPath,
  hasJetstreamHooks,
  runDoctor,
  type DoctorIO,
} from './doctor';
import type { BoardLayout } from './board-layout';
import { DECK_MODELS } from './profile';

describe('runDoctor listener check', () => {
  const io = (listenerAlive: boolean): DoctorIO => ({
    env: {},
    claudeOnPath: () => true,
    ghOnPath: () => true,
    settingsRaw: () => undefined,
    projectsRaw: () => undefined,
    listenerAlive: async () => listenerAlive,
    boardLayout: () => null,
  });
  it('warns when the hook listener is not responding (the silent dark-board case)', async () => {
    const listener = (await runDoctor(io(false))).find((r) => /listener/i.test(r.message));
    expect(listener?.status).toBe('warn');
  });
  it('passes when the listener responds', async () => {
    const listener = (await runDoctor(io(true))).find((r) => /listener/i.test(r.message));
    expect(listener?.status).toBe('ok');
  });
});

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

  it('warns (with an in-app hooks fix) when no jetstream hook is present', () => {
    const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } };
    expect(hasJetstreamHooks(other)).toBe(false);
    const result = checkHooksPresent(JSON.stringify(other));
    expect(result.status).toBe('warn');
    expect(result.fixId).toBe('hooks'); // the checklist offers a one-press install
    expect(checkHooksPresent('{}').status).toBe('warn');
  });

  it('distinguishes an absent settings file from a corrupt one', () => {
    const absent = checkHooksPresent(undefined);
    const corrupt = checkHooksPresent('{ not json');
    expect(absent.status).toBe('warn');
    expect(absent.fixId).toBe('hooks'); // absent → installing creates it
    expect(corrupt.status).toBe('warn');
    expect(corrupt.fixId).toBeUndefined(); // corrupt → NOT auto-fixable (install would re-fail the parse)
    expect(corrupt.message).toContain('not valid JSON');
    expect(corrupt.message).not.toEqual(absent.message); // don't send the user to a fix that also fails
  });
});

describe('checkUsageStatusline', () => {
  const withStatusHook = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/n" "/x/bin/status-hook.js"' }] }] },
      ...extra,
    });

  it('ok when the usage statusline hook is wired', () => {
    const raw = withStatusHook({ statusLine: { command: '"/n" "/x/bin/usage-hook.js"' } });
    expect(checkUsageStatusline(raw).status).toBe('ok');
  });

  it('warns (with a hooks fix) when Jetstream hooks are present but the usage statusline is missing', () => {
    const r = checkUsageStatusline(withStatusHook({}));
    expect(r.status).toBe('warn');
    expect(r.fixId).toBe('hooks');
    expect(r.message).toContain('usage-hook.js');
  });

  it('stays quiet when settings are absent, empty, or corrupt (the hooks check leads there)', () => {
    expect(checkUsageStatusline(undefined).status).toBe('ok');
    expect(checkUsageStatusline('{}').status).toBe('ok'); // no Jetstream hooks at all
    expect(checkUsageStatusline('{bad json').status).toBe('ok'); // corrupt → don't double-warn
  });
});

describe('checkBoardKeys', () => {
  const board = (uuids: string[]): BoardLayout => ({
    profileName: 'My Board',
    deck: DECK_MODELS[0]!,
    keys: new Map(uuids.map((uuid, i) => [`${i},0`, { uuid, settings: null, label: '' }])),
  });

  it('warns (fleet fix) when no board is detected', () => {
    const r = checkBoardKeys(null);
    expect(r.status).toBe('warn');
    expect(r.fixId).toBe('fleet');
  });

  it('warns (fleet fix) when the board has zero Jetstream keys', () => {
    const r = checkBoardKeys(board(['com.elgato.streamdeck.system.open']));
    expect(r.status).toBe('warn');
    expect(r.fixId).toBe('fleet');
  });

  it('ok and counts only the Jetstream keys present', () => {
    const r = checkBoardKeys(board(['gg.pim.jetstream.fleet', 'gg.pim.jetstream.project', 'com.elgato.x']));
    expect(r.status).toBe('ok');
    expect(r.message).toContain('2 Jetstream key');
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
