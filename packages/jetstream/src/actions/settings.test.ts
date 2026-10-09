import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import streamDeck from '@elgato/streamdeck';
import { writeFleetFile } from '../fleet';
import { readConfigFile } from '../projects-config';
import { board } from '../state';
import {
  diagnosticsText,
  routeInspectorMessage,
  type InspectorRoutes,
  fixId,
  isBuildLayout,
  isDiagnostics,
  isHealthCheck,
  isProfileSwitch,
  isToolDetail,
  hasWarnings,
  SettingsKey,
  writeFleetFromEditor,
} from './settings';
import type { CheckResult } from '../doctor';

// Every projects.json read passes through; a test can set `afterRead` to land another writer's
// change right after the next read, between the fleet route's read and its write.
const h = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock('../projects-config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../projects-config')>();
  return {
    ...real,
    readConfigFile: (...args: Parameters<typeof real.readConfigFile>) => {
      const file = real.readConfigFile(...args);
      const afterRead = h.afterRead;
      h.afterRead = undefined; // once only: the write's own re-read under the lock must not run it
      afterRead?.();
      return file;
    },
  };
});

// Each guard matches exactly one { key: 'value' } shape from the property inspector and
// must reject everything else — payloads arrive as untrusted unknown JSON.
const guards = [
  { guard: isHealthCheck, key: 'health', value: 'check' },
  { guard: isProfileSwitch, key: 'profile', value: 'switch' },
  { guard: isToolDetail, key: 'hooks', value: 'toolDetail' },
  { guard: isBuildLayout, key: 'build', value: 'layout' },
  { guard: isDiagnostics, key: 'diag', value: 'copy' },
] as const;

describe('property-inspector payload guards', () => {
  it('accept exactly their { key: value } shape', () => {
    for (const { guard, key, value } of guards) {
      expect(guard({ [key]: value })).toBe(true);
      expect(guard({ [key]: value, extra: 1 })).toBe(true); // extra keys are fine
    }
  });

  it('reject null, non-objects, and missing keys', () => {
    for (const { guard, value } of guards) {
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard(value)).toBe(false); // the bare string is not the shape
      expect(guard(42)).toBe(false);
      expect(guard({})).toBe(false);
    }
  });

  it('reject the right key with the wrong value or type', () => {
    for (const { guard, key } of guards) {
      expect(guard({ [key]: 'other' })).toBe(false);
      expect(guard({ [key]: true })).toBe(false);
      expect(guard({ [key]: null })).toBe(false);
    }
  });

  it('do not answer to each other\'s payloads', () => {
    for (const { guard, key } of guards) {
      for (const other of guards) {
        if (other.key === key) continue;
        expect(guard({ [other.key]: other.value })).toBe(false);
      }
    }
  });
});

// This is now purely about the FACE. The press is unconditional — it always opens doctor — because
// a press whose meaning depends on invisible health state is unpredictable: a permanently-warning
// check (the token grace period warns for two releases) used to hijack the key for that whole
// window, making its other action unreachable and a press look like it did nothing.
describe('hasWarnings', () => {
  const ok = (message: string): CheckResult => ({ status: 'ok', message });
  const warn = (message: string): CheckResult => ({ status: 'warn', message });

  it("is true while any check is failing (drives the amber 'setup N/M' face)", () => {
    expect(hasWarnings([ok('claude on PATH'), warn('9/10: update available')])).toBe(true);
    expect(hasWarnings([warn('no projects yet')])).toBe(true);
  });

  it('is false once every check passes, and for an empty checklist', () => {
    expect(hasWarnings([ok('claude on PATH'), ok('on the latest version')])).toBe(false);
    expect(hasWarnings([])).toBe(false);
  });
});

describe('fixId', () => {
  it('returns the fix id when it is a string', () => {
    expect(fixId({ fix: 'hooks' })).toBe('hooks');
    expect(fixId({ fix: 'fleet' })).toBe('fleet');
  });

  it('returns undefined for null, non-objects, missing, and non-string fix', () => {
    expect(fixId(null)).toBeUndefined();
    expect(fixId(undefined)).toBeUndefined();
    expect(fixId({})).toBeUndefined();
    expect(fixId({ fix: 7 })).toBeUndefined();
    expect(fixId({ fix: { id: 'hooks' } })).toBeUndefined();
    expect(fixId('hooks')).toBeUndefined(); // the bare string is not the shape
  });
});

describe('routeInspectorMessage', () => {
  const routes = (): InspectorRoutes & { hit: string[] } => {
    const hit: string[] = [];
    const mark = (name: string) => async () => void hit.push(name);
    return {
      hit,
      health: mark('health'),
      fixHooks: mark('fixHooks'),
      switchProfiles: mark('switchProfiles'),
      toolDetail: mark('toolDetail'),
      buildLayout: mark('buildLayout'),
      diagnostics: mark('diagnostics'),
      fleet: async () => void hit.push('fleet'),
    };
  };

  it('sends each inspector message to its own handler, and everything else to the fleet editor', async () => {
    const cases: Array<[unknown, string]> = [
      [{ health: 'check' }, 'health'],
      [{ fix: 'hooks' }, 'fixHooks'],
      [{ profile: 'switch' }, 'switchProfiles'],
      [{ hooks: 'toolDetail' }, 'toolDetail'],
      [{ build: 'layout' }, 'buildLayout'],
      [{ diag: 'copy' }, 'diagnostics'],
      [{ fleet: 'list' }, 'fleet'],
      [{ fix: 'fleet' }, 'fleet'], // only the hooks fix has its own handler
      ['junk', 'fleet'],
    ];
    for (const [payload, expected] of cases) {
      const r = routes();
      await routeInspectorMessage(payload, r);
      expect(r.hit, JSON.stringify(payload)).toEqual([expected]);
    }
  });
});

describe('diagnosticsText', () => {
  it('lists every check with an OK/WARN prefix under the platform line', () => {
    const checks: CheckResult[] = [
      { status: 'ok', message: 'hooks wired' },
      { status: 'warn', message: 'no token' },
    ];
    expect(diagnosticsText(checks, 'darwin', 'v24.1.0')).toBe(
      'Jetstream diagnostics\nplatform: darwin  node: v24.1.0\n\nOK   hooks wired\nWARN no token',
    );
  });
});

describe('writeFleetFromEditor', () => {
  const p = (id: string) => ({ id, name: id, path: `/r/${id}` });
  const dirs: string[] = [];
  const fleetPath = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-editor-')));
    dirs.push(dir);
    return join(dir, 'projects.json');
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('replays only the edit onto the file, keeping a repo another writer added since the read', async () => {
    const path = fleetPath();
    writeFleetFile(path, [p('a')]);
    const base = readConfigFile(path);
    writeFleetFile(path, [p('a'), p('b')]); // another writer adds b
    await writeFleetFromEditor(path, [p('a'), p('c')], {}, base); // the editor adds c
    expect(readConfigFile(path).projects.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  // The plugin's only thread runs keys and hooks, so the editor must wait for a held lock without blocking it.
  it('waits for a held lock without blocking, then writes once it is released', async () => {
    const path = fleetPath();
    writeFleetFile(path, [p('a')]);
    writeFileSync(`${path}.lock`, 'live writer');
    setTimeout(() => rmSync(`${path}.lock`, { force: true }), 300); // the other writer finishes
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 10); // stands in for the plugin's keys and hooks
    try {
      await writeFleetFromEditor(path, [p('a'), p('b')], {}, readConfigFile(path));
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(0); // the thread kept running while the editor waited
    expect(readConfigFile(path).projects.map((x) => x.id)).toEqual(['a', 'b']);
  });

  // Fake timers stand in for the 3 s wait; the lock loop reads the global setTimeout and Date.
  it('gives up on a lock still held after 3 s, like the CLI', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const path = fleetPath();
      writeFleetFile(path, [p('a')]);
      writeFileSync(`${path}.lock`, 'live writer');
      let outcome: string | undefined;
      void writeFleetFromEditor(path, [p('a'), p('b')], {}, readConfigFile(path)).then(
        () => (outcome = 'saved'),
        (error: Error) => (outcome = error.message),
      );
      await vi.advanceTimersByTimeAsync(2_900);
      expect(outcome).toBeUndefined(); // still waiting
      await vi.advanceTimersByTimeAsync(200);
      expect(outcome).toMatch(/try again/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SettingsKey fleet route', () => {
  const p = (id: string) => ({ id, name: id, path: `/r/${id}` });
  const dirs: string[] = [];
  // Points the route at a temp projects.json (HOME too, so no fallback path is the real one) and
  // collects what it replies to the property inspector.
  const setup = (): { path: string; replies: unknown[] } => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-route-')));
    dirs.push(dir);
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    vi.stubEnv('HOME', dir);
    mkdirSync(join(dir, 'jetstream'));
    const path = join(dir, 'jetstream', 'projects.json');
    writeFleetFile(path, [p('a')]);
    const replies: unknown[] = [];
    vi.spyOn(streamDeck.ui, 'sendToPropertyInspector').mockImplementation(async (msg) => {
      replies.push(msg);
    });
    vi.spyOn(board, 'seed').mockImplementation(() => {});
    return { path, replies };
  };
  afterEach(() => {
    h.afterRead = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  // The route is what the plugin runs: a short hold by another writer is waited out, not refused.
  it('waits for a held lock and then saves, instead of answering try again', async () => {
    const { path, replies } = setup();
    writeFileSync(`${path}.lock`, 'live writer');
    setTimeout(() => rmSync(`${path}.lock`, { force: true }), 300); // the other writer finishes
    await new SettingsKey().onSendToPlugin({ payload: { fleet: 'remove', id: 'a' } });
    expect(replies).toEqual([{ fleet: 'projects', projects: [] }]);
    expect(readConfigFile(path).projects).toEqual([]);
  });

  it("writes only its own removal, keeping a repo another writer added after the route's read", async () => {
    const { path, replies } = setup();
    h.afterRead = () => writeFleetFile(path, [p('a'), p('b')]); // another writer adds b
    await new SettingsKey().onSendToPlugin({ payload: { fleet: 'remove', id: 'a' } });
    expect(readConfigFile(path).projects).toEqual([p('b')]);
    expect(replies).toEqual([{ fleet: 'projects', projects: [p('b')] }]);
    expect(board.seed).toHaveBeenCalledWith([p('b')]);
  });

  // Read before the removal saved, the re-add would see a duplicate, write nothing, and the removal would win.
  it('runs a re-add sent during a removal lock wait only after the removal saved, so the repo stays', async () => {
    const { path, replies } = setup();
    writeFileSync(`${path}.lock`, 'live writer');
    const key = new SettingsKey();
    const removing = key.onSendToPlugin({ payload: { fleet: 'remove', id: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 60)); // the removal is waiting for the lock
    const adding = key.onSendToPlugin({ payload: { fleet: 'add', path: '/r/a' } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    rmSync(`${path}.lock`, { force: true }); // the other writer finishes
    await Promise.all([removing, adding]);
    expect(readConfigFile(path).projects).toEqual([p('a')]);
    expect(replies).toEqual([
      { fleet: 'projects', projects: [] },
      { fleet: 'projects', projects: [p('a')] },
    ]);
  });

  it('keeps serving fleet messages after one fails, and still hands that failure to its caller', async () => {
    const { replies } = setup();
    vi.mocked(streamDeck.ui.sendToPropertyInspector).mockImplementationOnce(() => {
      throw new Error('inspector gone');
    });
    const key = new SettingsKey();
    await expect(key.onSendToPlugin({ payload: { fleet: 'list' } })).rejects.toThrow('inspector gone');
    await key.onSendToPlugin({ payload: { fleet: 'list' } });
    expect(replies).toEqual([{ fleet: 'projects', projects: [p('a')] }]);
  });
});
