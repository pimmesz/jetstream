import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The tunable long-press sits at its 200 ms floor: arming must ignore it and wait for ARM_HOLD_MS.
vi.mock('../config', () => ({ config: { get: () => ({ longPressMs: 200 }) } }));

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
  FACE_SUMMARY_MAX: 18,
}));

import { ARM_HOLD_MS, PermissionKey } from './permission';

beforeEach(() => {
  vi.useFakeTimers(); // a press is held by advancing the clock between key-down and key-up
  settle.mockReset().mockReturnValue(true);
  allowAlways.mockReset().mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

const fakeKey = () => ({
  id: 'k1',
  isKey: () => true,
  setImage: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
  showOk: vi.fn(async () => {}),
  showAlert: vi.fn(async () => {}),
});
type Key = ReturnType<typeof fakeKey>;
// shownIds is set privately by renderAll; seed the fake key's entry to model "what its face is showing now".
const seedShown = (key: PermissionKey, id: string | undefined): void => {
  (key as unknown as { shownIds: Map<string, string | undefined> }).shownIds.set('k1', id);
};
const down = (key: PermissionKey, action: Key, decision?: 'allow' | 'deny'): void =>
  key.onKeyDown({ action, payload: { settings: { decision } } } as unknown as Parameters<PermissionKey['onKeyDown']>[0]);
const up = (key: PermissionKey, action: Key, decision?: 'allow' | 'deny'): Promise<void> =>
  key.onKeyUp({ action, payload: { settings: { decision } } } as unknown as Parameters<PermissionKey['onKeyUp']>[0]);

describe('PermissionKey — acts on the request shown at key-DOWN, not the live head', () => {
  it('a head-swap during the hold still acts on the ORIGINAL request id, never the new one', async () => {
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A'); // the face shows request A
    down(key, a, 'allow'); // a short tap starts on A → captures 'A'
    seedShown(key, 'B'); // A is answered/times out; head → B; face repaints, shownId → 'B'
    await up(key, a, 'allow');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith('A', 'allow'); // the captured id, NOT the live 'B'
  });

  it('a hold of ARM_HOLD_MS on APPROVE arms via allowAlways with the captured id', async () => {
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a, 'allow');
    vi.advanceTimersByTime(ARM_HOLD_MS);
    await up(key, a, 'allow');
    expect(allowAlways).toHaveBeenCalledWith('A');
    expect(settle).not.toHaveBeenCalled();
    expect(a.showOk).toHaveBeenCalled();
  });

  it('arming ignores the tunable longPressMs: a hold just short of ARM_HOLD_MS approves once', async () => {
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a, 'allow');
    vi.advanceTimersByTime(ARM_HOLD_MS - 1); // far past the 200 ms longPressMs
    await up(key, a, 'allow');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith('A', 'allow');
    expect(allowAlways).not.toHaveBeenCalled();
  });

  it('DENY is one-shot even on a long hold, never arms a rule', async () => {
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a, 'deny');
    vi.advanceTimersByTime(ARM_HOLD_MS);
    await up(key, a, 'deny');
    expect(settle).toHaveBeenCalledWith('A', 'deny');
    expect(allowAlways).not.toHaveBeenCalled();
  });

  it('a stale captured id after a head swap (settle returns false) alerts, with no second decision', async () => {
    settle.mockReturnValue(false);
    const key = new PermissionKey();
    const a = fakeKey();
    seedShown(key, 'A');
    down(key, a, 'allow');
    seedShown(key, 'B'); // A left the queue during the press; the face now shows B
    await up(key, a, 'allow');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith('A', 'allow');
    expect(settle).not.toHaveBeenCalledWith('B', expect.anything()); // B was never reviewed
    expect(allowAlways).not.toHaveBeenCalled();
    expect(a.showAlert).toHaveBeenCalled();
  });
});
