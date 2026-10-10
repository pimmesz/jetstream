import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('@pimmesz/jetstream-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pimmesz/jetstream-usage')>()),
  resolveUsage: vi.fn(),
}));
import { resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { gaugeColor, usageFace, UsageKey } from './usage';

const GREEN = '#30a46c';
const AMBER = '#ffb224';
const RED = '#e5484d';

function feed(fiveHour?: number, sevenDay?: number): UsageFeed {
  return {
    source: 'test',
    available: true,
    ...(fiveHour !== undefined ? { fiveHour: { usedPct: fiveHour } } : {}),
    ...(sevenDay !== undefined ? { sevenDay: { usedPct: sevenDay } } : {}),
  };
}

describe('gaugeColor', () => {
  it('is green with headroom (under half the budget), including a data-less feed', () => {
    expect(gaugeColor(feed(0, 0))).toBe(GREEN);
    expect(gaugeColor(feed(49.9, 10))).toBe(GREEN);
    expect(gaugeColor(feed())).toBe(GREEN); // no windows at all → 0 used
  });

  it('turns amber at exactly 50 and red at exactly 90', () => {
    expect(gaugeColor(feed(49.9, 0))).toBe(GREEN);
    expect(gaugeColor(feed(50, 0))).toBe(AMBER);
    expect(gaugeColor(feed(89.9, 0))).toBe(AMBER);
    expect(gaugeColor(feed(90, 0))).toBe(RED);
    expect(gaugeColor(feed(100, 0))).toBe(RED);
  });

  it('follows the tighter window when one is undefined', () => {
    expect(gaugeColor(feed(undefined, 91))).toBe(RED);
    expect(gaugeColor(feed(80, undefined))).toBe(AMBER);
    expect(gaugeColor(feed(undefined, 49))).toBe(GREEN);
  });

  it('takes the max of both windows', () => {
    expect(gaugeColor(feed(10, 80))).toBe(AMBER);
    expect(gaugeColor(feed(95, 20))).toBe(RED);
  });
});

describe('usageFace', () => {
  it('a Codex gauge names itself on top; a Claude gauge keeps the 5h line there', () => {
    expect(usageFace(feed(undefined, 55), 0, 'codex')).toMatchObject({ top: 'codex', label: '7d 55%' });
    expect(usageFace(feed(12, 40), 0, 'codex')).toMatchObject({ top: 'codex 5h 12%', label: '7d 40%' });
    expect(usageFace(feed(12, 40), 0, 'claude')).toMatchObject({ top: '5h 12%', label: '7d 40%' });
  });

  it('a Codex gauge with no data says to run codex', () => {
    expect(usageFace({ source: 'codex', available: false }, 0, 'codex')).toMatchObject({ label: 'no codex', sub: 'run codex' });
  });

  it('both gauges say "used" with the sooner reset while the reading is fresh', () => {
    const now = 1_000_000_000_000;
    const fresh: UsageFeed = { ...feed(12, 40), sevenDay: { usedPct: 40, resetsAt: now / 1000 + 2 * 3600 }, readAt: now - 5 * 60_000 };
    expect(usageFace(fresh, now, 'claude').sub).toBe('used·resets 2h');
    expect(usageFace(fresh, now, 'codex').sub).toBe('used·resets 2h');
    expect(usageFace(feed(12, 40), now, 'claude').sub).toBe('used'); // no reset known, no reading time known
  });

  it('both gauges show the age instead of the reset once the reading is over an hour old', () => {
    const now = 1_000_000_000_000;
    const stale: UsageFeed = { ...feed(12, 52), sevenDay: { usedPct: 52, resetsAt: now / 1000 + 3600 }, readAt: now - 15 * 3_600_000 };
    expect(usageFace(stale, now, 'claude').sub).toBe('used·15h old');
    expect(usageFace(stale, now, 'codex').sub).toBe('used·15h old');
    expect(usageFace({ ...stale, readAt: now - 60 * 60_000 }, now, 'codex').sub).toBe('used·resets 1h'); // exactly an hour is still fresh
  });

  it('a Codex free plan names its 30-day window, not 7d', () => {
    const monthly: UsageFeed = { source: 'codex', available: true, sevenDay: { usedPct: 40, windowMinutes: 43200 } };
    expect(usageFace(monthly, 0, 'codex')).toMatchObject({ top: 'codex', label: '30d 40%' });
  });
});

describe('UsageKey.onKeyDown', () => {
  afterEach(() => {
    vi.mocked(resolveUsage).mockReset();
    vi.unstubAllEnvs();
  });

  /** A Usage key on the deck, with the SDK calls a press and a repaint make. */
  function placedKey() {
    const action = {
      id: `usage-${Math.random()}`,
      isKey: () => true,
      setImage: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      showOk: vi.fn(async () => {}),
      showAlert: vi.fn(async () => {}),
    };
    const key = new UsageKey();
    Object.defineProperty(key, 'actions', { value: [action], configurable: true });
    return { key, action };
  }
  const press = (key: UsageKey, action: ReturnType<typeof placedKey>['action']) =>
    key.onKeyDown({ action } as unknown as Parameters<UsageKey['onKeyDown']>[0]);

  it('re-reads usage now, repaints, and confirms', async () => {
    const { key, action } = placedKey();
    vi.mocked(resolveUsage).mockResolvedValue(feed(12, 40));
    await press(key, action);
    expect(resolveUsage).toHaveBeenCalledTimes(1);
    expect(action.setImage).toHaveBeenCalledTimes(1);
    expect(action.showOk).toHaveBeenCalled();
    expect(action.showAlert).not.toHaveBeenCalled();
  });

  it('alerts when the re-read still finds no usage', async () => {
    // The blank face reads Claude's settings to pick its hint: point that at an empty folder.
    vi.stubEnv('CLAUDE_CONFIG_DIR', await mkdtemp(join(tmpdir(), 'jetstream-usage-key-')));
    const { key, action } = placedKey();
    vi.mocked(resolveUsage).mockResolvedValue({ source: 'claude', available: false });
    await press(key, action);
    expect(resolveUsage).toHaveBeenCalledTimes(1);
    expect(action.showAlert).toHaveBeenCalled();
    expect(action.showOk).not.toHaveBeenCalled();
  });

  it('alerts instead of rejecting when the repaint times out', async () => {
    const { key, action } = placedKey();
    action.setTitle.mockRejectedValue(new Error('The request timed out'));
    vi.mocked(resolveUsage).mockResolvedValue(feed(12, 40));
    await press(key, action);
    expect(action.showAlert).toHaveBeenCalledTimes(1);
    expect(action.showOk).not.toHaveBeenCalled();
  });

  it('answers from its own read when a newer refresh is still in flight', async () => {
    const { key, action } = placedKey();
    let releasePress!: (value: UsageFeed) => void;
    let releaseTimer!: (value: UsageFeed) => void;
    vi.mocked(resolveUsage)
      .mockImplementationOnce(() => new Promise<UsageFeed>((resolve) => (releasePress = resolve)))
      .mockImplementationOnce(() => new Promise<UsageFeed>((resolve) => (releaseTimer = resolve)));
    const pressed = press(key, action);
    const timer = key.refresh();
    releasePress(feed(12, 40));
    await pressed;
    expect(action.showOk).toHaveBeenCalledTimes(1);
    expect(action.showAlert).not.toHaveBeenCalled();
    releaseTimer(feed(12, 40));
    await timer;
  });
});
