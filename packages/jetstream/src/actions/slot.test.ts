import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlotKey, slotFace } from './slot';
import { stopFace } from './interrupt-all';
import { modelFace } from './model';
import { config } from '../config';

vi.mock('../switchto'); // spy interruptPids — a stopall press must SIGINT the fleet ONLY when enabled
import { interruptPids } from '../switchto';
vi.mock('../output-volume'); // spy the volume-key presses
import { nudgeOutputVolume, toggleOutputMute } from '../output-volume';

describe('slotFace', () => {
  it('empty → a blank dark key (absent kind = empty)', () => {
    expect(slotFace({ kind: 'empty' })).toMatchObject({ label: '', color: '#1c1c20' });
    expect(slotFace({})).toMatchObject({ label: '' });
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

describe('SlotKey.onKeyDown run gate', () => {
  it('does NOT execute a run slot while run keys are disabled — paints a reason instead', async () => {
    const setImage = vi.fn(async () => {});
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
    expect(setImage).toHaveBeenCalled(); // the "run off — enable in settings" face, not execution
    expect(showOk).not.toHaveBeenCalled(); // never reaches execPlan/runPlan
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

  it('modelFace → purple with the override name, or dim "default" (shared pure fn)', () => {
    expect(modelFace('opus')).toMatchObject({ color: '#7c5cff', sub: 'opus' });
    expect(modelFace('')).toMatchObject({ color: '#26262b', sub: 'default' });
  });

  it('volume kinds paint a static face and drive output volume on press (no gate — benign)', async () => {
    expect(slotFace({ kind: 'volup' })).toMatchObject({ label: 'vol +', sub: 'output' });
    expect(slotFace({ kind: 'volmute' })).toMatchObject({ label: 'mute', glyph: '🔇' });
    const press = async (kind: string) => {
      const action = { showOk: vi.fn(async () => {}), setTitle: vi.fn(async () => {}), setImage: vi.fn(async () => {}), isKey: () => true };
      await new SlotKey().onKeyDown({ payload: { settings: { kind } }, action } as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    };
    await press('volup');
    expect(nudgeOutputVolume).toHaveBeenCalledWith(6);
    await press('voldown');
    expect(nudgeOutputVolume).toHaveBeenCalledWith(-6);
    await press('volmute');
    expect(toggleOutputMute).toHaveBeenCalled();
  });

  it('stopall is INERT until allowStopKeys — a planted fleet-SIGINT can never fire from /slot', async () => {
    const setImage = vi.fn(async () => {});
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
    expect(setImage).toHaveBeenCalled(); // the "stop off — enable in settings" notice
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
