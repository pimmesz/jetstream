import { describe, it, expect, vi, beforeEach } from 'vitest';

// longPressMs is flipped per test: a huge value → every press is a short tap (settle path); 0 →
// every press is a long hold (arm path).
const h = vi.hoisted(() => ({ longPressMs: 0 }));
vi.mock('../config', () => ({ config: { get: () => ({ longPressMs: h.longPressMs }) } }));

const settle = vi.fn<(id: string | undefined, decision: string) => boolean>(() => true);
const allowAlways = vi.fn<(id: string | undefined) => boolean>(() => true);
vi.mock('../permissions', () => ({
  permissions: {
    settle: (id: string | undefined, d: string) => settle(id, d),
    allowAlways: (id: string | undefined) => allowAlways(id),
    head: () => undefined,
    count: () => 0,
    allowRuleCount: () => 0,
  },
}));

import { PermissionKey } from './permission';

beforeEach(() => {
  settle.mockReset().mockReturnValue(true);
  allowAlways.mockReset().mockReturnValue(true);
});

const fakeKey = () => ({
  id: 'k1',
  isKey: () => true,
  setImage: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
  showOk: vi.fn(async () => {}),
  showAlert: vi.fn(async () => {}),
});
type Key = ReturnType<typeof fakeKey>;
// shownId is set privately by renderAll; seed it directly to model "what the face is showing now".
const seedShown = (key: PermissionKey, id: string | undefined): void => {
  (key as unknown as { shownId?: string }).shownId = id;
};
const down = (key: PermissionKey, action: Key): void =>
  key.onKeyDown({ action } as unknown as Parameters<PermissionKey['onKeyDown']>[0]);
const up = (key: PermissionKey, action: Key, decision?: 'allow' | 'deny'): Promise<void> =>
  key.onKeyUp({ action, payload: { settings: { decision } } } as unknown as Parameters<PermissionKey['onKeyUp']>[0]);

describe('PermissionKey — acts on the request shown at key-DOWN, not the live head', () => {
  it('a head-swap during the hold still acts on the ORIGINAL request id, never the new one', async () => {
    h.longPressMs = 999_999; // short tap → settle path
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A'); // the face shows request A
    down(key, a); // press starts on A → captures 'A'
    seedShown(key, 'B'); // A is answered/times out; head → B; face repaints, shownId → 'B'
    await up(key, a, 'allow');
    expect(settle).toHaveBeenCalledWith('A', 'allow'); // the captured id, NOT the live 'B'
  });

  it('long-press on APPROVE arms via allowAlways with the captured id', async () => {
    h.longPressMs = 0; // long hold
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a);
    await up(key, a, 'allow');
    expect(allowAlways).toHaveBeenCalledWith('A');
    expect(a.showOk).toHaveBeenCalled();
  });

  it('DENY is one-shot even on a long hold — never arms a rule', async () => {
    h.longPressMs = 0; // long hold
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a);
    await up(key, a, 'deny');
    expect(settle).toHaveBeenCalledWith('A', 'deny');
    expect(allowAlways).not.toHaveBeenCalled();
  });

  it('a stale captured id (settle returns false) → showAlert, no blind approve', async () => {
    h.longPressMs = 999_999;
    settle.mockReturnValue(false);
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a);
    await up(key, a, 'allow');
    expect(a.showAlert).toHaveBeenCalled();
  });
});
