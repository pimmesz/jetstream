import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlotKey, slotFace } from './slot';
import { stopFace } from './interrupt-all';
import { config } from '../config';
import { board } from '../state';

vi.mock('../switchto'); // spy interruptPids — a stopall press must SIGINT the fleet ONLY when enabled
import { interruptPids } from '../switchto';
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

/** A fake KeyAction at a coordinate, with spies for the mutations assign() makes. */
function fakeKey(column: number, row: number) {
  return {
    isKey: () => true,
    coordinates: { column, row },
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
      // The identical settings the SDK echoes via getSettings()→onDidReceiveSettings: the guard must NOT
      // setProject again — that emit would drive renderBoard → renderKind → getSettings → … forever.
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
  beforeEach(() => vi.mocked(interruptPids).mockReset());

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

  it('stopall is INERT until allowStopKeys — a planted fleet-SIGINT can never fire from /slot', async () => {
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
    expect(interruptPids).not.toHaveBeenCalled(); // never SIGINTs the fleet while disabled
    expect(showOk).not.toHaveBeenCalled();
  });

  it('stopall SIGINTs the fleet on press once allowStopKeys is enabled', async () => {
    vi.mocked(interruptPids).mockReturnValue(2); // pretend two sessions were signalled
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
      expect(interruptPids).toHaveBeenCalled();
      expect(showOk).toHaveBeenCalled(); // sent > 0 → ack
    } finally {
      config.set(undefined); // restore defaults so sibling tests see allowStopKeys=false
    }
  });
});
