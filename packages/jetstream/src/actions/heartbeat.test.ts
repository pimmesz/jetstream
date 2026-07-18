import { describe, it, expect, vi, beforeEach } from 'vitest';

// longPressMs 0 → every press counts as a long press (the fire path), deterministically.
vi.mock('../config', () => ({ config: { get: () => ({ longPressMs: 0 }) } }));
vi.mock('../afterburner-cli', () => ({ runAfterburner: vi.fn() }));

import { runAfterburner } from '../afterburner-cli';
import { HeartbeatKey } from './heartbeat';

beforeEach(() => vi.mocked(runAfterburner).mockReset());

const fakeKey = () => ({
  id: 'k1',
  isKey: () => true,
  setImage: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
  showOk: vi.fn(async () => {}),
  showAlert: vi.fn(async () => {}),
});
type Key = ReturnType<typeof fakeKey>;
const down = (hb: HeartbeatKey, action: Key) =>
  hb.onKeyDown({ action } as unknown as Parameters<HeartbeatKey['onKeyDown']>[0]);
const up = (hb: HeartbeatKey, action: Key) =>
  hb.onKeyUp({ action } as unknown as Parameters<HeartbeatKey['onKeyUp']>[0]);

describe('HeartbeatKey long-press run-once', () => {
  it('fires run-once with a bounded timeout (never 0 — a wedged cycle must be killable)', async () => {
    const hb = new HeartbeatKey();
    vi.spyOn(hb, 'refresh').mockResolvedValue();
    const a = fakeKey();
    vi.mocked(runAfterburner).mockResolvedValue('');
    down(hb, a);
    await up(hb, a);
    expect(runAfterburner).toHaveBeenCalledWith(['run-once'], expect.any(Number));
    const timeout = vi.mocked(runAfterburner).mock.calls[0]![1] as number;
    expect(timeout).toBeGreaterThan(0);
  });

  it('drops a second long-press while a cycle is already firing (no double-fire)', async () => {
    const hb = new HeartbeatKey();
    vi.spyOn(hb, 'refresh').mockResolvedValue();
    const a = fakeKey();
    let release!: () => void;
    const gate = new Promise<string>((r) => (release = () => r('')));
    vi.mocked(runAfterburner).mockReturnValueOnce(gate).mockResolvedValue('');

    down(hb, a);
    const first = up(hb, a); // enters the fire path, sets firing=true, blocks on runAfterburner
    down(hb, a);
    const second = up(hb, a); // sees firing=true synchronously → bounces, no second cycle
    await second;
    expect(a.showAlert).toHaveBeenCalledTimes(1);

    release(); // let the one in-flight cycle finish
    await first;
    expect(runAfterburner).toHaveBeenCalledTimes(1); // exactly one run-once, not two
  });
});
