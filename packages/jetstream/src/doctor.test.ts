import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  checkAnthropicEnv,
  checkBoardKeys,
  checkHooksPresent,
  checkLatestVersion,
  checkProjectsConfig,
  checkListenerToken,
  checkOrphanedKeys,
  readDeclaredActions,
  checkUsageStatusline,
  usageStatuslineWired,
  commandOnPath,
  hasJetstreamHooks,
  runDoctor,
  type DoctorIO,
} from './doctor';
import { ENFORCE_TOKEN } from './listener-token';
import type { BoardLayout } from './board-layout';
import { DECK_MODELS } from './profile';

describe('runDoctor listener check', () => {
  const io = (listenerAlive: boolean): DoctorIO => ({
    env: {},
    claudeOnPath: () => true,
    settingsRaw: () => undefined,
    projectsRaw: () => undefined,
    listenerAlive: async () => listenerAlive,
    boardLayout: () => null,
    latestVersion: async () => null,
    listenerToken: () => ({ present: true, private: true }),
    declaredActions: () => [],
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

describe('checkLatestVersion', () => {
  it('warns (with the update command) when a newer version is published', () => {
    const r = checkLatestVersion('1.3.1', '1.4.0');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('jetstream update');
    expect(r.message).toContain('1.4.0');
  });

  it('ok when already on the latest', () => {
    expect(checkLatestVersion('1.4.0', '1.4.0').status).toBe('ok');
    expect(checkLatestVersion('1.4.0', '1.4.0').message).toContain('latest');
  });

  it('ok (never warns) when installed is AHEAD of the registry — a local dev build', () => {
    expect(checkLatestVersion('1.5.0', '1.4.0').status).toBe('ok');
  });

  it('stays quiet (best-effort) when the registry is unreachable or a version is non-numeric', () => {
    expect(checkLatestVersion('1.4.0', null).status).toBe('ok'); // offline
    expect(checkLatestVersion('dev', '1.4.0').status).toBe('ok'); // untooled build
    expect(checkLatestVersion('1.4.0', 'garbage').status).toBe('ok');
  });

  it('compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(checkLatestVersion('1.9.0', '1.10.0').status).toBe('warn');
    expect(checkLatestVersion('1.10.0', '1.9.0').status).toBe('ok');
  });
});

describe('checkUsageStatusline', () => {
  const withStatusHook = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/n" "/x/bin/status-hook.js"' }] }] },
      ...extra,
    });

  it('ok when the usage statusline hook is wired', () => {
    const raw = withStatusHook({
      statusLine: { type: 'command', command: '"/n" "/x/bin/usage-hook.js"' },
    });
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

  // The regression that blanked the gauge: mergeHooks never clobbers a foreign statusline, so the
  // old "run `jetstream hooks install`" advice (and the one-press Fix) silently did nothing.
  it('points at the routes that actually take the slot when a foreign statusline holds it', () => {
    const raw = withStatusHook({
      statusLine: { type: 'command', command: '"/n" "/opt/homebrew/bin/afterburner" statusline' },
    });
    const r = checkUsageStatusline(raw);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/another statusline/i);
    // Both consenting routes, and NOT the bare `hooks install` that silently no-ops here.
    expect(r.message).toContain('--replace-statusline');
    expect(r.message).toMatch(/press Fix/i);
    expect(r.fixId).toBe('hooks'); // the press is the consent, so the button can fix it
  });

  it('treats a non-object statusline as foreign too (mergeHooks only fills an ABSENT slot)', () => {
    const r = checkUsageStatusline(withStatusHook({ statusLine: 'some-other-tool' }));
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/another statusline/i);
  });
});

describe('usageStatuslineWired', () => {
  const statusLine = (extra: Record<string, unknown>): string => JSON.stringify({ statusLine: extra });

  it('is true only when the configured statusline runs OUR usage hook', () => {
    expect(usageStatuslineWired(statusLine({ type: 'command', command: '"/n" "/x/bin/usage-hook.js"' }))).toBe(true);
    expect(usageStatuslineWired(statusLine({ type: 'command', command: 'afterburner statusline' }))).toBe(false);
    expect(usageStatuslineWired(JSON.stringify({}))).toBe(false);
    expect(usageStatuslineWired(undefined)).toBe(false);
    expect(usageStatuslineWired('{bad json')).toBe(false);
  });

  // Must agree with mergeHooks' own "is it ours?" test, which requires type:'command' — otherwise
  // doctor shows a green check over a slot the installer still refuses to wire.
  it('requires type:"command", matching what the installer treats as ours', () => {
    expect(usageStatuslineWired(statusLine({ command: '"/n" "/x/bin/usage-hook.js"' }))).toBe(false);
    expect(usageStatuslineWired(statusLine({ type: 'other', command: 'x/usage-hook.js' }))).toBe(false);
  });
});

describe('checkBoardKeys', () => {
  const board = (uuids: string[]): BoardLayout => ({
    profileName: 'My Board',
    deck: DECK_MODELS[0]!,
    keys: new Map(uuids.map((uuid, i) => [`${i},0`, { uuid, settings: null, label: '' }])),
    allUuids: uuids,
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

describe('checkListenerToken', () => {
  it('warns loudly when there is no token at all — the listener is wide open', () => {
    const r = checkListenerToken({ present: false, private: false });
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/any local process/);
  });

  it('warns when the token is readable by other users, which is the whole threat it addresses', () => {
    const r = checkListenerToken({ present: true, private: false });
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/chmod 600/);
  });

  it('does NOT warn during the grace period — nothing the user does could clear it', () => {
    // A warning whose prescribed command cannot change the outcome trains people to ignore
    // doctor. The grace period is expected state, so it reports ok and says no action is needed;
    // when ENFORCE_TOKEN flips, the same input stays ok with the stricter wording.
    const r = checkListenerToken({ present: true, private: true });
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(ENFORCE_TOKEN ? /required/ : /no action needed/);
  });
});

describe('checkOrphanedKeys', () => {
  const board = (uuids: Record<string, string>): BoardLayout => ({
    profileName: 'Jetstream',
    deck: DECK_MODELS[0]!,
    keys: new Map(
      Object.entries(uuids).map(([coord, uuid]) => [coord, { uuid, settings: null, label: '' }]),
    ),
    allUuids: Object.values(uuids),
  });
  const DECLARED = ['gg.pim.jetstream.project', 'gg.pim.jetstream.slot', 'gg.pim.jetstream.usage'];

  // The real case: v2.0.0 deleted the CI and Launch actions, but Stream Deck keeps the keys —
  // they render as blank squares that do nothing, and checkBoardKeys counts them as healthy
  // because the UUID still starts with gg.pim.jetstream.
  it('names the coordinates of keys whose action this build no longer declares', () => {
    const r = checkOrphanedKeys(
      board({
        '0,0': 'gg.pim.jetstream.project',
        '1,3': 'gg.pim.jetstream.ci', // d2
        '2,3': 'gg.pim.jetstream.launch', // d3
      }),
      DECLARED,
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('d2');
    expect(r.message).toContain('d3');
    expect(r.message).toMatch(/2 key/);
  });

  it('ignores keys from OTHER plugins — they are not ours to judge', () => {
    const r = checkOrphanedKeys(
      board({ '0,0': 'com.elgato.streamdeck.system.text', '1,0': 'gg.pim.jetstream.slot' }),
      DECLARED,
    );
    expect(r.status).toBe('ok');
  });

  it('stays silent when the manifest could not be read, rather than flagging every key', () => {
    // An empty `declared` means "cannot tell", not "nothing is declared" — treating it as the
    // latter would warn about the entire board on any manifest read failure.
    expect(checkOrphanedKeys(board({ '0,0': 'gg.pim.jetstream.project' }), []).status).toBe('ok');
    expect(checkOrphanedKeys(null, DECLARED).status).toBe('ok');
  });

  it('counts an orphan hidden on another page behind a live key at the same coordinate', () => {
    // `keys` keeps only the first page's key per coordinate, so page 2's dead key is invisible
    // there. Without scanning allUuids this reported a clean board while a blank key sat on page 2.
    const b = board({ '0,0': 'gg.pim.jetstream.project' });
    b.allUuids = ['gg.pim.jetstream.project', 'gg.pim.jetstream.ci'];
    const r = checkOrphanedKeys(b, DECLARED);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/another page/);
  });

  it('is ok on a healthy board', () => {
    expect(checkOrphanedKeys(board({ '0,0': 'gg.pim.jetstream.project' }), DECLARED).status).toBe('ok');
  });
});

describe('readDeclaredActions', () => {
  it("reads the plugin's own action UUIDs, and degrades to [] on any failure", () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-doctor-'));
    const good = join(dir, 'manifest.json');
    writeFileSync(good, JSON.stringify({ Actions: [{ UUID: 'a' }, { UUID: 'b' }, { nope: 1 }] }));
    expect(readDeclaredActions(good)).toEqual(['a', 'b']);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(readDeclaredActions(bad)).toEqual([]);
    expect(readDeclaredActions(join(dir, 'absent.json'))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('agrees with the REAL manifest this repo ships', () => {
    // Guards the shape assumption: if Elgato ever changes `Actions` from an array, the check
    // would silently start returning [] and never warn again.
    const real = readDeclaredActions(
      new URL('../gg.pim.jetstream.sdPlugin/manifest.json', import.meta.url).pathname,
    );
    expect(real.length).toBeGreaterThan(5);
    expect(real).toContain('gg.pim.jetstream.slot');
    expect(real).not.toContain('gg.pim.jetstream.ci'); // removed in v2.0.0
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
