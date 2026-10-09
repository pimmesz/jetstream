import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlotKey, slotFace } from './slot';
import { sameSlot } from '../slot-command';
import { stopFace } from './interrupt-all';
import { config } from '../config';
import { board } from '../state';
import { doorbell } from '../doorbell';

vi.mock('../switchto');
vi.mock('../stop-session'); // spy stopSessions: a stopall press must stop the fleet ONLY when enabled
import { stopSessions } from '../stop-session';
vi.mock('../output-volume'); // spy the volume-key presses
import { nudgeOutputVolume, toggleOutputMute } from '../output-volume';
// Keep execPlan real (it builds the plan we assert on) but spy runPlan so no real process spawns.
vi.mock('../slot-exec', async (orig) => ({
  ...(await orig<typeof import('../slot-exec')>()),
  runPlan: vi.fn(() => true),
}));
import { runPlan } from '../slot-exec';
// Keep icon resolution real, but spy forgetIcon so we can prove assign INVALIDATES the cache on a
// retarget — the wiring, not just the cache lifecycle the slot-icon unit test covers.
vi.mock('../slot-icon', async (orig) => ({
  ...(await orig<typeof import('../slot-icon')>()),
  forgetIcon: vi.fn(),
}));
import { forgetIcon } from '../slot-icon';
vi.mock('../exec-terminal'); // spy openInTerminal — the 'logo'/'chat' kinds launch `jetstream chat`
import { openInTerminal } from '../exec-terminal';
// Never read the real ~/.jetstream usage snapshots: a usage refresh gets a fixed feed.
vi.mock('@pimmesz/jetstream-usage', async (orig) => ({
  ...(await orig<typeof import('@pimmesz/jetstream-usage')>()),
  resolveUsage: vi.fn(async () => ({ source: 'claude', available: false })),
}));
import { resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { openProject } from '../switchto';

describe('slotFace', () => {
  it('empty → a blank dark key (absent kind = empty)', () => {
    expect(slotFace({ kind: 'empty' })).toMatchObject({ label: '', color: '#1c1c20' });
    expect(slotFace({})).toMatchObject({ label: '' });
    // 'logo' carries a branded fallback face; the render path paints the bundled mark over it.
    expect(slotFace({ kind: 'logo' })).toMatchObject({ label: 'jetstream', color: '#0b0d12' });
  });
  it('app → app name (basename minus .app), overridable by label', () => {
    expect(slotFace({ kind: 'app', app: '/Applications/Telegram.app' }).label).toBe('Telegram');
    expect(slotFace({ kind: 'app', app: '/Applications/Telegram.app', label: 'Chat' }).label).toBe('Chat');
  });
  it('url → hostname in the sub-line; run → command + a glyph', () => {
    expect(slotFace({ kind: 'url', url: 'https://www.github.com/x' }).sub).toBe('github.com');
    expect(slotFace({ kind: 'run', command: 'code' })).toMatchObject({ label: 'code', glyph: '▸' });
  });
  it('user overrides (colour, subtitle, emoji, rename) win over the per-kind defaults', () => {
    const f = slotFace({
      kind: 'app',
      app: '/Applications/Telegram.app',
      color: '#e5484d',
      sub: 'chat',
      glyph: '🚀',
      label: 'TG',
    });
    expect(f).toMatchObject({ color: '#e5484d', sub: 'chat', glyph: '🚀', label: 'TG' });
  });
  it('a colour or label override turns an empty slot into a styled spacer', () => {
    expect(slotFace({ kind: 'empty', color: '#e5484d', label: 'gap' })).toMatchObject({
      color: '#e5484d',
      label: 'gap',
    });
  });
  it('an emoji icon becomes the big main visual (not a corner glyph); image icons do not', () => {
    expect(slotFace({ kind: 'app', app: '/Applications/Telegram.app', icon: '🔥' })).toMatchObject({ emoji: '🔥' });
    expect(slotFace({ kind: 'app', app: '/x.app', icon: '/x/logo.png' }).emoji).toBeUndefined();
    expect(slotFace({ kind: 'app', app: '/x.app', icon: 'data:image/png;base64,AAA' }).emoji).toBeUndefined();
  });
  it('drops a corner glyph that just duplicates the emoji icon', () => {
    const f = slotFace({ kind: 'app', app: '/x.app', icon: '🔥', glyph: '🔥' });
    expect(f.emoji).toBe('🔥');
    expect(f.glyph).toBeUndefined();
    // a DIFFERENT glyph is kept alongside the emoji
    expect(slotFace({ kind: 'app', app: '/x.app', icon: '🔥', glyph: '🔔' })).toMatchObject({ emoji: '🔥', glyph: '🔔' });
  });
});

/** A fake KeyAction at a coordinate, with spies for the mutations assign() makes. `type` is the SDK
 * DeviceType of its deck (0 Standard, 1 Mini, 2 XL); left out, the key has no device at all. */
function fakeKey(column: number, row: number, type?: number) {
  return {
    isKey: () => true,
    coordinates: { column, row },
    ...(type === undefined ? {} : { device: { type } }),
    setSettings: vi.fn(async () => {}),
    setImage: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  };
}

/** Build a SlotKey whose `this.actions` iterates the given fakes (shadows the SDK getter). */
function slotWith(keys: unknown[]): SlotKey {
  const slot = new SlotKey();
  Object.defineProperty(slot, 'actions', { value: keys, configurable: true });
  return slot;
}

describe('SlotKey.assign', () => {
  it('retargets the slot at the matching coordinate (setSettings full replace)', async () => {
    const key = fakeKey(7, 0);
    const res = await slotWith([fakeKey(0, 0), key]).assign({
      coord: 'a8',
      kind: 'app',
      app: '/Applications/Telegram.app',
    });
    expect(res.status).toBe(200);
    expect(key.setSettings).toHaveBeenCalledWith({ kind: 'app', app: '/Applications/Telegram.app' });
  });

  // Retargeting must INVALIDATE the icon cache for the new source — otherwise an app whose icon
  // failed to extract once stays blank forever (defect #10). Dropping the forgetIcon calls from
  // assign leaves this red; the slot-icon unit test alone would not catch removing the wiring.
  it('invalidates the icon cache for the retargeted app on assign', async () => {
    vi.mocked(forgetIcon).mockClear();
    await slotWith([fakeKey(7, 0)]).assign({ coord: 'a8', kind: 'app', app: '/Applications/Telegram.app' });
    expect(forgetIcon).toHaveBeenCalledWith('/Applications/Telegram.app');
  });

  it('a slow edit that finishes after a newer one repaints from the settings the key holds', async () => {
    let held: Record<string, unknown> = {};
    const key = {
      ...fakeKey(7, 0),
      id: 'k1',
      setSettings: vi.fn(async (s: Record<string, unknown>) => void (held = s)),
      getSettings: vi.fn(async () => held),
    };
    const slot = slotWith([key]);
    const painted: unknown[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    // The first render waits (an icon extraction stuck past chat's 2 s timeout); later ones are instant.
    vi.spyOn(slot as unknown as { render: (a: unknown, s: unknown) => Promise<void> }, 'render').mockImplementation(
      async (_a, s) => {
        if (painted.length === 0 && (s as { app?: string }).app === '/Applications/New.app') await slow;
        painted.push(s);
      },
    );
    const first = slot.assign({ coord: 'a8', kind: 'app', app: '/Applications/New.app' });
    await slot.assign({ coord: 'a8', kind: 'app', app: '/Applications/Old.app' }); // chat's rollback
    release();
    await first;
    expect(held).toEqual({ kind: 'app', app: '/Applications/Old.app' });
    expect(painted.at(-1)).toEqual({ kind: 'app', app: '/Applications/Old.app' }); // face matches settings
  });

  it('keeps repainting until no newer edit landed during its own corrective repaint', async () => {
    let held: Record<string, unknown> = {};
    const key = {
      ...fakeKey(7, 0),
      id: 'k2',
      setSettings: vi.fn(async (s: Record<string, unknown>) => void (held = s)),
      getSettings: vi.fn(async () => held),
    };
    const slot = slotWith([key]);
    const painted: string[] = [];
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    let reachedRepaint: () => void = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    const repaintStarted = new Promise<void>((r) => (reachedRepaint = r));
    let bRenders = 0;
    vi.spyOn(slot as unknown as { render: (a: unknown, s: unknown) => Promise<void> }, 'render').mockImplementation(
      async (_a, s) => {
        const app = String((s as { app?: string }).app);
        if (app === '/A.app' && !painted.includes('/A.app')) await gateA;
        if (app === '/B.app' && ++bRenders === 2) {
          reachedRepaint(); // A's corrective repaint is drawing B, slowly
          await gateB;
        }
        painted.push(app);
      },
    );
    const first = slot.assign({ coord: 'a8', kind: 'app', app: '/A.app' });
    await slot.assign({ coord: 'a8', kind: 'app', app: '/B.app' });
    releaseA();
    await repaintStarted;
    await slot.assign({ coord: 'a8', kind: 'app', app: '/C.app' }); // lands during the corrective repaint
    releaseB();
    await first;
    expect(held).toEqual({ kind: 'app', app: '/C.app' });
    expect(painted.at(-1)).toBe('/C.app');
  });

  it('refuses (409) and changes nothing when the key no longer holds what the caller expects', async () => {
    const key = { ...fakeKey(7, 0), id: 'k3', getSettings: vi.fn(async () => ({ kind: 'app', app: '/B.app' })) };
    const res = await slotWith([key]).assign({ coord: 'a8', kind: 'url', url: 'https://x.dev', expect: { kind: 'app', app: '/A.app' } });
    expect(res.status).toBe(409);
    expect(key.setSettings).not.toHaveBeenCalled();
    const ok = await slotWith([key]).assign({ coord: 'a8', kind: 'url', url: 'https://x.dev', expect: { kind: 'app', app: '/B.app' } });
    expect(ok.status).toBe(200);
  });

  it('two overlapping writes that expect the same settings: only the first gets through', async () => {
    let held: Record<string, unknown> = { kind: 'empty' };
    const key = {
      ...fakeKey(7, 0),
      id: 'k4',
      getSettings: vi.fn(async () => held),
      setSettings: vi.fn(async (s: Record<string, unknown>) => void (held = s)),
    };
    const slot = slotWith([key]);
    const [a, b] = await Promise.all([
      slot.assign({ coord: 'a8', kind: 'url', url: 'https://a.dev', expect: { kind: 'empty' } }),
      slot.assign({ coord: 'a8', kind: 'url', url: 'https://b.dev', expect: { kind: 'empty' } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 409]);
    expect(held).toEqual({ kind: 'url', url: 'https://a.dev' });
  });

  // The SDK's getSettings cache can be refilled with what the key held BEFORE a write (a reply that was
  // already in flight). The compare must use what the plugin knows it wrote, not that stale answer.
  it('compares against what the plugin last wrote, not a stale getSettings answer', async () => {
    const x = { kind: 'url', url: 'https://x.dev' };
    const key = { ...fakeKey(0, 0), id: 'k-stale', getSettings: vi.fn(async () => x) }; // always the pre-write value
    const slot = slotWith([key]);
    await slot.onWillAppear({ action: key, payload: { settings: x } } as unknown as Parameters<SlotKey['onWillAppear']>[0]);
    expect((await slot.assign({ coord: 'a1', kind: 'empty', expect: x })).status).toBe(200);
    // The key now holds an empty slot, whatever the SDK cache still says.
    const stale = await slot.assign({ coord: 'a1', kind: 'url', url: 'https://z.dev', expect: x });
    expect(stale.status).toBe(409);
    const real = await slot.assign({ coord: 'a1', kind: 'url', url: 'https://y.dev', expect: { kind: 'empty' } });
    expect(real.status).toBe(200);
    expect(key.setSettings).toHaveBeenLastCalledWith({ kind: 'url', url: 'https://y.dev' });
  });

  // Repaints read the same record: a stale getSettings answer must not paint the pre-write face back.
  it('a board-tick renderKind does not paint the pre-write face back over a live edit', async () => {
    const x = { kind: 'url', url: 'https://x.dev' };
    const key = { ...fakeKey(0, 0), id: 'k-stale-tick', getSettings: vi.fn(async () => x) }; // always the pre-write value
    const slot = slotWith([key]);
    await slot.onWillAppear({ action: key, payload: { settings: x } } as unknown as Parameters<SlotKey['onWillAppear']>[0]);
    expect((await slot.assign({ coord: 'a1', kind: 'empty', expect: x })).status).toBe(200);
    const render = vi.spyOn(slot as unknown as { render: (a: unknown, s: unknown) => Promise<void> }, 'render');
    await slot.renderKind('url');
    expect(render).not.toHaveBeenCalled();
  });

  it('the run-off repaint draws what the key holds now, not a stale getSettings answer', async () => {
    vi.useFakeTimers();
    try {
      const run = { kind: 'run', command: 'echo' };
      const key = { ...fakeKey(0, 0), id: 'k-stale-repaint', getSettings: vi.fn(async () => run), showOk: vi.fn() };
      const slot = slotWith([key]);
      await slot.onWillAppear({ action: key, payload: { settings: run } } as unknown as Parameters<SlotKey['onWillAppear']>[0]);
      await slot.onKeyDown({ payload: { settings: run }, action: key } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
      await slot.assign({ coord: 'a1', kind: 'empty' });
      const render = vi.spyOn(slot as unknown as { render: (a: unknown, s: unknown) => Promise<void> }, 'render');
      await vi.advanceTimersByTimeAsync(2700);
      expect(render).toHaveBeenLastCalledWith(key, { kind: 'empty' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a usage refresh sees a gauge placed by a live edit, not a stale getSettings answer', async () => {
    const x = { kind: 'url', url: 'https://x.dev' };
    const key = { ...fakeKey(0, 0), id: 'k-stale-usage', getSettings: vi.fn(async () => x) };
    const slot = slotWith([key]);
    await slot.onWillAppear({ action: key, payload: { settings: x } } as unknown as Parameters<SlotKey['onWillAppear']>[0]);
    await slot.assign({ coord: 'a1', kind: 'usage' });
    vi.mocked(resolveUsage).mockClear();
    await slot.refreshUsage();
    expect(resolveUsage).toHaveBeenCalled();
  });

  it('an inspector edit updates what the compare expects; a key that disappears is forgotten', async () => {
    const key = { ...fakeKey(0, 0), id: 'k-inspector', getSettings: vi.fn(async () => ({ kind: 'empty' })) };
    const slot = slotWith([key]);
    const edited = { kind: 'url', url: 'https://inspector.dev' };
    await slot.onDidReceiveSettings({ action: key, payload: { settings: edited } } as unknown as Parameters<SlotKey['onDidReceiveSettings']>[0]);
    expect((await slot.assign({ coord: 'a1', kind: 'empty', expect: { kind: 'empty' } })).status).toBe(409);
    expect((await slot.assign({ coord: 'a1', kind: 'empty', expect: edited })).status).toBe(200);
    slot.onWillDisappear({ action: key, payload: { settings: {} } } as unknown as Parameters<SlotKey['onWillDisappear']>[0]);
    key.getSettings.mockResolvedValue(edited); // back to asking Stream Deck once there is no record
    expect((await slot.assign({ coord: 'a1', kind: 'empty', expect: edited })).status).toBe(200);
  });

  it('sameSlot treats a missing kind as an empty slot', () => {
    expect(sameSlot({}, { kind: 'empty' })).toBe(true);
    expect(sameSlot({ kind: 'app', app: '/A.app' }, { kind: 'app', app: '/A.app' })).toBe(true);
    expect(sameSlot({ kind: 'app', app: '/A.app' }, { kind: 'app', app: '/B.app' })).toBe(false);
  });

  it('404s when no visible slot sits at the coordinate', async () => {
    const res = await slotWith([fakeKey(0, 0)]).assign({ coord: 'a8', kind: 'empty' });
    expect(res.status).toBe(404);
  });

  it('400s a malformed command without touching any key', async () => {
    const key = fakeKey(0, 0);
    const res = await slotWith([key]).assign({ coord: 'zz' });
    expect(res.status).toBe(400);
    expect(key.setSettings).not.toHaveBeenCalled();
  });
});

// Every connected deck has its own a1. Chat names the deck model its plan is for, and the plugin
// refuses (404, so chat offers the restart write) rather than guess between two candidates.
describe('SlotKey.assign with two Stream Decks', () => {
  const MINI = 1;
  const XL = 2;
  const PLUS = 7;
  /** A slot at a1 on a deck of the given DeviceType, holding `held`. */
  function deckKey(id: string, type: number, held: Record<string, unknown> = { kind: 'empty' }) {
    return { ...fakeKey(0, 0, type), id, getSettings: vi.fn(async () => held) };
  }
  const edit = { coord: 'a1', kind: 'url', url: 'https://x.dev', expect: { kind: 'empty' } };

  it('an edit naming the XL changes the XL slot, not the Mini slot at the same coordinate', async () => {
    const mini = deckKey('mini-a1', MINI);
    const xl = deckKey('xl-a1', XL);
    const res = await slotWith([mini, xl]).assign({ ...edit, deck: 'xl' });
    expect(res.status).toBe(200);
    expect(xl.setSettings).toHaveBeenCalledWith({ kind: 'url', url: 'https://x.dev' });
    expect(mini.setSettings).not.toHaveBeenCalled();
  });

  it('two slots at one coordinate and no deck named are refused, neither changes', async () => {
    const mini = deckKey('mini-a1', MINI);
    const xl = deckKey('xl-a1', XL);
    const res = await slotWith([mini, xl]).assign(edit);
    expect(res).toEqual({ status: 404, body: JSON.stringify({ error: 'a1 is a slot key on more than one Stream Deck' }) });
    expect(mini.setSettings).not.toHaveBeenCalled();
    expect(xl.setSettings).not.toHaveBeenCalled();
  });

  it('two decks of the same model at one coordinate are refused, neither changes', async () => {
    const first = deckKey('xl1-a1', XL);
    const second = deckKey('xl2-a1', XL);
    const res = await slotWith([first, second]).assign({ ...edit, deck: 'xl' });
    expect(res.status).toBe(404);
    expect(first.setSettings).not.toHaveBeenCalled();
    expect(second.setSettings).not.toHaveBeenCalled();
  });

  it('a deck that has no slot at the coordinate gets 404, even if another deck has one', async () => {
    const mini = deckKey('mini-a1', MINI);
    const res = await slotWith([mini]).assign({ ...edit, deck: 'xl' });
    expect(res).toEqual({ status: 404, body: JSON.stringify({ error: 'no slot key at a1' }) });
    expect(mini.setSettings).not.toHaveBeenCalled();
  });

  it('a deck the plugin cannot map never matches a named deck', async () => {
    // A Stream Deck + has no deck model, so an XL edit must not land on its a1.
    const plus = deckKey('plus-a1', PLUS);
    const res = await slotWith([plus]).assign({ ...edit, deck: 'xl' });
    expect(res).toEqual({ status: 404, body: JSON.stringify({ error: 'no slot key at a1' }) });
    expect(plus.setSettings).not.toHaveBeenCalled();
  });

  it('the deck filter keeps the compare: the only XL slot holding something else answers 409', async () => {
    const mini = deckKey('mini-a1', MINI);
    const xl = deckKey('xl-a1', XL, { kind: 'app', app: '/A.app' });
    const res = await slotWith([mini, xl]).assign({ ...edit, deck: 'xl' });
    expect(res.status).toBe(409);
    expect(mini.setSettings).not.toHaveBeenCalled();
    expect(xl.setSettings).not.toHaveBeenCalled();
  });
});

describe('SlotKey project kind — registration loop guard', () => {
  it('registers a project on assign, and an UNCHANGED re-assign does NOT re-register (breaks the render loop)', async () => {
    const key = { ...fakeKey(0, 0), id: 'proj-loop-1' };
    const slot = slotWith([key]);
    const setProject = vi.spyOn(board, 'setProject');
    try {
      const r1 = await slot.assign({ coord: 'a1', kind: 'project', path: '/dev/loudini', name: 'Loudini' });
      expect(r1.status).toBe(200);
      expect(board.project('proj-loop-1')).toMatchObject({ path: '/dev/loudini', name: 'Loudini' });
      const afterFirst = setProject.mock.calls.length;
      // An identical repeat must NOT setProject again: that emit would repaint every key for nothing.
      await slot.assign({ coord: 'a1', kind: 'project', path: '/dev/loudini', name: 'Loudini' });
      expect(setProject.mock.calls.length).toBe(afterFirst);
      // A real re-point DOES re-register.
      await slot.assign({ coord: 'a1', kind: 'project', path: '/dev/other', name: 'Other' });
      expect(setProject.mock.calls.length).toBe(afterFirst + 1);
      // Retargeting away from project deregisters it.
      await slot.assign({ coord: 'a1', kind: 'empty' });
      expect(board.project('proj-loop-1')).toBeUndefined();
    } finally {
      setProject.mockRestore();
      board.removeProject('proj-loop-1');
    }
  });
});

describe('SlotKey.onKeyDown run gate', () => {
  it('does NOT execute a run slot while run keys are disabled — paints a reason instead', async () => {
    const setImage = vi.fn(async (_img: string) => {});
    const showOk = vi.fn(async () => {});
    const action = {
      setImage,
      setTitle: vi.fn(async () => {}),
      showOk,
      isKey: () => true,
      coordinates: { column: 0, row: 0 },
      getSettings: vi.fn(async () => ({ kind: 'run', command: 'echo' })), // the 2.6s repaint re-reads live settings
    };
    const ev = { payload: { settings: { kind: 'run', command: 'echo' } }, action };
    await new SlotKey().onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    // Assert WHAT it painted, not just that it painted — a blank or a live-run face would satisfy
    // toHaveBeenCalled while the gate silently failed. The notice must name the reason.
    const svg = decodeURIComponent(setImage.mock.calls.at(-1)?.[0] ?? '');
    expect(svg).toContain('run off');
    expect(showOk).not.toHaveBeenCalled(); // never reaches execPlan/runPlan
  });

  it('gates an app slot that points at a script exactly like a run key', async () => {
    const setImage = vi.fn(async (_img: string) => {});
    const showOk = vi.fn(async () => {});
    const settings = { kind: 'app', app: '/Users/me/Downloads/deploy.command' };
    const action = {
      id: 'script-key', // its own paint-cache entry, apart from the run-key test above
      setImage,
      setTitle: vi.fn(async () => {}),
      showOk,
      isKey: () => true,
      coordinates: { column: 0, row: 0 },
      getSettings: vi.fn(async () => settings),
    };
    await new SlotKey().onKeyDown({ payload: { settings }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    expect(decodeURIComponent(setImage.mock.calls.at(-1)?.[0] ?? '')).toContain('run off');
    expect(showOk).not.toHaveBeenCalled();
  });

  it('gates a project slot whose path is an executable file, and still opens a repo folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-slot-project-gate-'));
    try {
      const deploy = join(dir, 'deploy');
      writeFileSync(deploy, '#!/bin/sh\necho deployed\n');
      chmodSync(deploy, 0o755);
      const tap = async (path: string, id: string) => {
        const settings = { kind: 'project', path };
        const action = {
          ...fakeKey(0, 0),
          id,
          setImage: vi.fn(async (_img: string) => {}),
          showAlert: vi.fn(async () => {}),
          getSettings: vi.fn(async () => settings),
        };
        const ev = { payload: { settings }, action };
        const slot = slotWith([action]);
        await slot.onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
        await slot.onKeyUp(ev as unknown as Parameters<SlotKey['onKeyUp']>[0]);
        return action;
      };
      vi.mocked(openProject).mockClear().mockReturnValue(true);
      const gated = await tap(deploy, 'proj-exec');
      expect(decodeURIComponent(gated.setImage.mock.calls.at(-1)?.[0] ?? '')).toContain('run off');
      expect(openProject).not.toHaveBeenCalled();
      await tap(dir, 'proj-folder');
      expect(openProject).toHaveBeenCalledWith(dir);
      // A repo folder named like a script is still a folder.
      const threeJs = join(dir, 'three.js');
      mkdirSync(threeJs);
      await tap(threeJs, 'proj-three-js');
      expect(openProject).toHaveBeenCalledWith(threeJs);
    } finally {
      vi.mocked(openProject).mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An extensionless `chmod +x` script has no suffix to match, yet `open` runs it in Terminal.
  it('gates an app slot that points at an extensionless executable, and still opens a plain file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-slot-gate-'));
    try {
      const deploy = join(dir, 'deploy');
      const notes = join(dir, 'notes');
      writeFileSync(deploy, '#!/bin/sh\necho deployed\n');
      chmodSync(deploy, 0o755);
      writeFileSync(notes, 'just text\n');
      const press = async (app: string, id: string) => {
        const settings = { kind: 'app', app };
        const action = {
          id,
          setImage: vi.fn(async (_img: string) => {}),
          setTitle: vi.fn(async () => {}),
          showOk: vi.fn(async () => {}),
          showAlert: vi.fn(async () => {}),
          isKey: () => true,
          coordinates: { column: 0, row: 0 },
          getSettings: vi.fn(async () => settings),
        };
        await new SlotKey().onKeyDown({ payload: { settings }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
        return action;
      };
      vi.mocked(runPlan).mockClear().mockReturnValue(true);
      const gated = await press(deploy, 'noext-exec');
      expect(decodeURIComponent(gated.setImage.mock.calls.at(-1)?.[0] ?? '')).toContain('run off');
      expect(runPlan).not.toHaveBeenCalled();
      await press(notes, 'noext-plain');
      expect(runPlan).toHaveBeenCalledWith(expect.objectContaining({ args: [notes] }));
      // A folder opens whatever its name, so one called three.js is not a run key.
      const threeJs = join(dir, 'three.js');
      mkdirSync(threeJs);
      await press(threeJs, 'folder-three-js');
      expect(runPlan).toHaveBeenCalledWith(expect.objectContaining({ args: [threeJs] }));
    } finally {
      vi.mocked(runPlan).mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EXECUTES a run slot once allowRunKeys is enabled — the gate is the only thing that was off', async () => {
    config.set({ allowRunKeys: true });
    // Spy runPlan rather than spawn a real command: `echo` is a shell builtin on Windows (spawn
    // ENOENTs asynchronously → a false green), and asserting the dispatched PLAN is a stronger
    // check than "a process started". This is what proves dropping the allowRunKeys conjunct
    // (making run keys permanently inert) would be caught — the OFF-only test cannot.
    vi.mocked(runPlan).mockReturnValue(true);
    try {
      const showOk = vi.fn(async () => {});
      const action = {
        setImage: vi.fn(async () => {}),
        setTitle: vi.fn(async () => {}),
        showOk,
        showAlert: vi.fn(async () => {}),
        isKey: () => true,
        coordinates: { column: 0, row: 0 },
        getSettings: vi.fn(async () => ({ kind: 'run', command: 'echo' })),
      };
      const ev = { payload: { settings: { kind: 'run', command: 'echo', args: ['hi'] } }, action };
      await new SlotKey().onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
      // The gate opened, execPlan built a plan for the command, and runPlan was dispatched with it.
      expect(runPlan).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'echo', args: ['hi'] }));
      expect(showOk).toHaveBeenCalled();
    } finally {
      config.set(undefined); // restore so sibling tests see allowRunKeys=false
      vi.mocked(runPlan).mockReset();
    }
  });
});

describe('folded slot kinds: build + stopall', () => {
  beforeEach(() => vi.mocked(stopSessions).mockReset());

  it('build → the compile-time stamp face (a static kind, no board/timer)', () => {
    const f = slotFace({ kind: 'build' });
    expect(f).toMatchObject({ color: '#1f2933', sub: 'build' }); // BUILD_ID drives top/label
  });

  it('stopFace → red + live working-count when busy, dim idle otherwise (shared pure fn)', () => {
    expect(stopFace(2)).toMatchObject({ color: '#e5484d', sub: '2 working' });
    expect(stopFace(0)).toMatchObject({ color: '#26262b', sub: 'idle' });
  });


  it('volume kinds paint a static face and drive output volume on press (no gate — benign)', async () => {
    expect(slotFace({ kind: 'volup' })).toMatchObject({ label: 'vol +', sub: 'output' });
    expect(slotFace({ kind: 'volmute' })).toMatchObject({ label: 'mute', glyph: '🔇' });
    const press = async (kind: string) => {
      const action = {
        showOk: vi.fn(async () => {}),
        showAlert: vi.fn(async () => {}),
        setTitle: vi.fn(async () => {}),
        setImage: vi.fn(async () => {}),
        isKey: () => true,
      };
      await new SlotKey().onKeyDown({ payload: { settings: { kind } }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
      return action;
    };
    vi.mocked(nudgeOutputVolume).mockResolvedValue(true);
    vi.mocked(toggleOutputMute).mockResolvedValue(true);
    expect((await press('volup')).showOk).toHaveBeenCalled();
    expect(nudgeOutputVolume).toHaveBeenCalledWith(6);
    await press('voldown');
    expect(nudgeOutputVolume).toHaveBeenCalledWith(-6);
    expect((await press('volmute')).showOk).toHaveBeenCalled();
    expect(toggleOutputMute).toHaveBeenCalled();
  });

  // On a volume-fixed interface (or when osascript/bgm-vol fails) the helpers change nothing.
  // Flashing ✓ for a guaranteed no-op tells the user it worked when it did not.
  it('volume kinds ALERT instead of ✓ when the volume did not actually move', async () => {
    vi.mocked(nudgeOutputVolume).mockResolvedValue(false);
    vi.mocked(toggleOutputMute).mockResolvedValue(false);
    const action = {
      showOk: vi.fn(async () => {}),
      showAlert: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setImage: vi.fn(async () => {}),
      isKey: () => true,
    };
    for (const kind of ['volup', 'voldown', 'volmute']) {
      await new SlotKey().onKeyDown({ payload: { settings: { kind } }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    }
    expect(action.showAlert).toHaveBeenCalledTimes(3);
    expect(action.showOk).not.toHaveBeenCalled();
  });

  it('logo press opens `jetstream chat` in a terminal — the brand key doubles as a launcher', async () => {
    vi.mocked(openInTerminal).mockResolvedValue(true);
    const action = {
      showOk: vi.fn(async () => {}),
      showAlert: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setImage: vi.fn(async () => {}),
      isKey: () => true,
    };
    await new SlotKey().onKeyDown({ payload: { settings: { kind: 'logo' } }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    expect(openInTerminal).toHaveBeenCalledWith('chat');
    expect(action.showOk).toHaveBeenCalled();
    expect(action.showAlert).not.toHaveBeenCalled();
  });

  it('logo press ALERTS when the terminal launcher fails', async () => {
    vi.mocked(openInTerminal).mockResolvedValue(false);
    const action = {
      showOk: vi.fn(async () => {}),
      showAlert: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setImage: vi.fn(async () => {}),
      isKey: () => true,
    };
    await new SlotKey().onKeyDown({ payload: { settings: { kind: 'logo' } }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    expect(action.showAlert).toHaveBeenCalled();
    expect(action.showOk).not.toHaveBeenCalled();
  });

  it('stopall is INERT until allowStopKeys: a planted fleet stop can never fire from /slot', async () => {
    const setImage = vi.fn(async (_img: string) => {});
    const showOk = vi.fn(async () => {});
    const action = {
      setImage,
      showOk,
      setTitle: vi.fn(async () => {}),
      isKey: () => true,
      coordinates: { column: 0, row: 0 },
      getSettings: vi.fn(async () => ({ kind: 'stopall' })),
    };
    const ev = { payload: { settings: { kind: 'stopall' } }, action };
    await new SlotKey().onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    expect(decodeURIComponent(setImage.mock.calls.at(-1)?.[0] ?? '')).toContain('stop off'); // the gated-off notice, by content
    expect(stopSessions).not.toHaveBeenCalled(); // never stops the fleet while disabled
    expect(showOk).not.toHaveBeenCalled();
  });

  it('stopall stops the fleet on press once allowStopKeys is enabled', async () => {
    vi.mocked(stopSessions).mockReturnValue(2); // pretend two sessions were stopped
    config.set({ allowStopKeys: true });
    try {
      const showOk = vi.fn(async () => {});
      const action = {
        showOk,
        showAlert: vi.fn(async () => {}),
        setImage: vi.fn(async () => {}),
        setTitle: vi.fn(async () => {}),
        isKey: () => true,
        coordinates: { column: 0, row: 0 },
      };
      const ev = { payload: { settings: { kind: 'stopall' } }, action };
      await new SlotKey().onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
      expect(stopSessions).toHaveBeenCalled();
      expect(showOk).toHaveBeenCalled(); // sent > 0 → ack
    } finally {
      config.set(undefined); // restore defaults so sibling tests see allowStopKeys=false
    }
  });
});

describe('usage slot kind', () => {
  const gaugeKey = (id: string) => ({
    ...fakeKey(1, 0),
    id,
    getSettings: vi.fn(async () => ({ kind: 'usage' })),
    setImage: vi.fn(async (_img: string) => {}),
    showOk: vi.fn(async () => {}),
    showAlert: vi.fn(async () => {}),
  });
  const pressUsage = (slot: SlotKey, action: ReturnType<typeof gaugeKey>) =>
    slot.onKeyDown({ payload: { settings: { kind: 'usage' } }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);

  it('a slot whose settings read times out is skipped; the gauges still refresh and the press answers', async () => {
    const stuck = { ...fakeKey(0, 0), id: 'u-stuck', getSettings: vi.fn(async () => Promise.reject(new Error('The request timed out'))) };
    const gauge = gaugeKey('u-gauge');
    vi.mocked(resolveUsage).mockClear();
    await pressUsage(slotWith([stuck, gauge]), gauge);
    expect(resolveUsage).toHaveBeenCalled();
    expect(decodeURIComponent(gauge.setImage.mock.calls.at(-1)?.[0] ?? '')).toContain('no usage');
    // Still no usage after the re-read: an alert, like the standalone Usage key.
    expect(gauge.showAlert).toHaveBeenCalled();
    expect(gauge.showOk).not.toHaveBeenCalled();
  });

  it('a press that finds usage answers with a check', async () => {
    const gauge = gaugeKey('u-avail');
    vi.mocked(resolveUsage).mockResolvedValueOnce({ source: 'claude', available: true, fiveHour: { usedPct: 40 } });
    await pressUsage(slotWith([gauge]), gauge);
    expect(gauge.showOk).toHaveBeenCalled();
    expect(gauge.showAlert).not.toHaveBeenCalled();
  });

  it('a press answers from its own read when a newer refresh supersedes it', async () => {
    const gauge = gaugeKey('u-race');
    const slot = slotWith([gauge]);
    let finishPressRead: (feed: UsageFeed) => void = () => {};
    vi.mocked(resolveUsage)
      .mockClear()
      .mockImplementationOnce(() => new Promise<UsageFeed>((resolve) => (finishPressRead = resolve)))
      .mockResolvedValueOnce({ source: 'claude', available: false });
    const press = pressUsage(slot, gauge);
    await vi.waitFor(() => expect(resolveUsage).toHaveBeenCalledTimes(1));
    await slot.refreshUsage(); // a timer refresh starts and finishes while the press's read is still out
    finishPressRead({ source: 'claude', available: true, fiveHour: { usedPct: 40 } });
    await press;
    expect(gauge.showOk).toHaveBeenCalled();
    expect(gauge.showAlert).not.toHaveBeenCalled();
  });

  it('a press whose usage read fails shows an alert instead of nothing', async () => {
    const gauge = gaugeKey('u-fail');
    vi.mocked(resolveUsage).mockRejectedValueOnce(new Error('disk gone'));
    await pressUsage(slotWith([gauge]), gauge);
    expect(gauge.showAlert).toHaveBeenCalled();
    expect(gauge.showOk).not.toHaveBeenCalled();
  });
});

describe('attention slot kind', () => {
  it('a long hold goes through the shared doorbell with the time held, and does not jump', async () => {
    const press = vi.spyOn(doorbell, 'press').mockReturnValue({ act: 'snooze' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const settings = { kind: 'attention' };
      const action = { ...fakeKey(0, 0), id: 'att-1', showAlert: vi.fn(async () => {}) };
      const ev = { payload: { settings }, action };
      const slot = slotWith([action]);
      vi.mocked(openProject).mockClear();
      await slot.onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
      clock.mockReturnValue(13_000);
      await slot.onKeyUp(ev as unknown as Parameters<SlotKey['onKeyUp']>[0]);
      expect(press).toHaveBeenCalledWith(3_000);
      expect(openProject).not.toHaveBeenCalled();
      expect(action.showAlert).not.toHaveBeenCalled(); // key-down did not fall through to "nothing here"
    } finally {
      press.mockRestore();
      clock.mockRestore();
    }
  });
});
