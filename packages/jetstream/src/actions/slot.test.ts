import { describe, it, expect, vi } from 'vitest';
import { SlotKey, slotFace } from './slot';

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
  it('does NOT execute a run slot while run keys are disabled (the default)', async () => {
    const showAlert = vi.fn(async () => {});
    const showOk = vi.fn(async () => {});
    const ev = { payload: { settings: { kind: 'run', command: 'echo' } }, action: { showAlert, showOk } };
    await new SlotKey().onKeyDown(ev as unknown as Parameters<SlotKey['onKeyDown']>[0]);
    expect(showAlert).toHaveBeenCalled(); // inert: never reaches execPlan/runPlan
    expect(showOk).not.toHaveBeenCalled();
  });
});
