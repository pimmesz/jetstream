import { describe, it, expect, vi } from 'vitest';

// Hoisted knobs the mocks read, so a test can flip long-press length + what's waiting.
const h = vi.hoisted(() => ({ longPressMs: 0, waiting: [] as Array<{ id: string; name: string; path: string }> }));
vi.mock('../config', () => ({ config: { get: () => ({ longPressMs: h.longPressMs, escalateAfterSec: 300 }) } }));
vi.mock('../state', () => ({ board: { attention: () => h.waiting, byProject: () => ({}) } }));
vi.mock('../switchto', () => ({ openProject: vi.fn(() => true) }));

import { AttentionKey, pressAction, shouldFlash } from './attention';
import { openProject } from '../switchto';

describe('pressAction (doorbell key-up)', () => {
  it('long hold with something waiting → snooze', () => {
    expect(pressAction(2000, 1000, true)).toBe('snooze');
  });
  it('short tap with something waiting → jump', () => {
    expect(pressAction(200, 1000, true)).toBe('jump');
  });
  it('nothing waiting → a calm no-op either way', () => {
    expect(pressAction(200, 1000, false)).toBe('none');
    expect(pressAction(5000, 1000, false)).toBe('none');
  });
});

describe('shouldFlash (escalate unless snoozed)', () => {
  const AFTER = 300_000; // 5 min
  it('flashes once the oldest wait passes the threshold', () => {
    expect(shouldFlash(0, AFTER + 1, AFTER, 0)).toBe(true);
  });
  it('stays quiet while snoozed, even past the threshold', () => {
    expect(shouldFlash(0, AFTER + 1, AFTER, AFTER + 10_000)).toBe(false);
  });
  it('resumes flashing once the snooze window has passed', () => {
    expect(shouldFlash(0, AFTER + 1, AFTER, AFTER)).toBe(true); // now (AFTER+1) >= snoozedUntil (AFTER)
  });
  it('does not flash before the threshold', () => {
    expect(shouldFlash(0, AFTER - 1, AFTER, 0)).toBe(false);
    expect(shouldFlash(undefined, AFTER + 1, AFTER, 0)).toBe(false);
  });
});

describe('AttentionKey press routing', () => {
  const fakeKey = () => ({ id: 'a1', isKey: () => true, setImage: vi.fn(async () => {}), setTitle: vi.fn(async () => {}), showAlert: vi.fn(async () => {}) });
  type Key = ReturnType<typeof fakeKey>;
  const down = (att: AttentionKey, action: Key) =>
    att.onKeyDown({ action } as unknown as Parameters<AttentionKey['onKeyDown']>[0]);
  const up = (att: AttentionKey, action: Key) =>
    att.onKeyUp({ action } as unknown as Parameters<AttentionKey['onKeyUp']>[0]);

  it('short tap jumps to the neediest project', async () => {
    h.longPressMs = 999_999; // held ~0 < threshold → short tap
    h.waiting = [{ id: 'p1', name: 'proj', path: '/repo' }];
    vi.mocked(openProject).mockClear();
    const att = new AttentionKey();
    const a = fakeKey();
    down(att, a);
    await up(att, a);
    expect(openProject).toHaveBeenCalledWith('/repo');
  });

  it('long hold snoozes instead of jumping', async () => {
    h.longPressMs = 0; // held ~0 >= threshold → long hold
    h.waiting = [{ id: 'p1', name: 'proj', path: '/repo' }];
    vi.mocked(openProject).mockClear();
    const att = new AttentionKey();
    const a = fakeKey();
    down(att, a);
    await up(att, a);
    expect(openProject).not.toHaveBeenCalled();
  });
});
