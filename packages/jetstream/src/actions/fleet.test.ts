import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetKey } from './fleet';
import { board } from '../state';
import { forgetAllPainted, forgetPainted } from '../paint';

/** A visible Fleet key whose setImage records each upload. */
function fakeKey(id: string) {
  return {
    id,
    isKey: () => true,
    setImage: vi.fn(async (_img: string) => {}),
    setTitle: vi.fn(async () => {}),
    showOk: vi.fn(async () => {}),
  };
}

const lastFace = (key: ReturnType<typeof fakeKey>): string =>
  decodeURIComponent(key.setImage.mock.calls.at(-1)?.[0] ?? '');

describe('FleetKey "why dark?" notice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forgetAllPainted();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('owns the key until it expires, then the live fleet face returns', async () => {
    vi.spyOn(board, 'byProject').mockReturnValue({}); // dark board: the press explains itself
    const key = fakeKey('fleet-1');
    const fleet = new FleetKey();
    Object.defineProperty(fleet, 'actions', { value: [key], configurable: true });

    await fleet.onKeyDown({ action: key } as unknown as Parameters<FleetKey['onKeyDown']>[0]);
    expect(lastFace(key)).toContain('why dark?');

    // A routine render mid-notice (a board emit, the 30 s tick) must not repaint the live face over it.
    await vi.advanceTimersByTimeAsync(1000);
    await fleet.renderAll();
    expect(lastFace(key)).toContain('why dark?');

    await vi.advanceTimersByTimeAsync(1700);
    expect(lastFace(key)).toContain('fleet');
    expect(lastFace(key)).not.toContain('why dark?');
  });

  it('still reverts when the timer fires 1 ms before the clock reaches the deadline', async () => {
    vi.spyOn(board, 'byProject').mockReturnValue({});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const key = fakeKey('fleet-early');
    const fleet = new FleetKey();
    Object.defineProperty(fleet, 'actions', { value: [key], configurable: true });

    await fleet.onKeyDown({ action: key } as unknown as Parameters<FleetKey['onKeyDown']>[0]);
    expect(lastFace(key)).toContain('why dark?');

    now.mockReturnValue(1_000_000 + 2600 - 1);
    await vi.advanceTimersByTimeAsync(2600);
    expect(lastFace(key)).toContain('fleet');
    expect(lastFace(key)).not.toContain('why dark?');
  });

  it('a second press during the notice keeps the newer notice past the first timer', async () => {
    vi.spyOn(board, 'byProject').mockReturnValue({});
    const key = fakeKey('fleet-twice');
    const fleet = new FleetKey();
    Object.defineProperty(fleet, 'actions', { value: [key], configurable: true });
    const press = () => fleet.onKeyDown({ action: key } as unknown as Parameters<FleetKey['onKeyDown']>[0]);

    await press();
    await vi.advanceTimersByTimeAsync(1000);
    await press();

    // The first press's timer fires; the second press still owns the key for another second.
    await vi.advanceTimersByTimeAsync(1700);
    expect(lastFace(key)).toContain('why dark?');

    await vi.advanceTimersByTimeAsync(1000);
    expect(lastFace(key)).toContain('fleet');
    expect(lastFace(key)).not.toContain('why dark?');
  });

  it('a key that reappears mid-notice paints the live face at once', async () => {
    vi.spyOn(board, 'byProject').mockReturnValue({});
    const key = fakeKey('fleet-back');
    const fleet = new FleetKey();
    Object.defineProperty(fleet, 'actions', { value: [key], configurable: true });

    await fleet.onKeyDown({ action: key } as unknown as Parameters<FleetKey['onKeyDown']>[0]);
    expect(lastFace(key)).toContain('why dark?');

    // Page away and back mid-notice: the deck blanks the key, and plugin.ts forgets its painted face.
    await vi.advanceTimersByTimeAsync(1000);
    forgetPainted(key.id);
    const uploads = key.setImage.mock.calls.length;
    fleet.onWillAppear({ action: key } as unknown as Parameters<FleetKey['onWillAppear']>[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(key.setImage.mock.calls.length).toBe(uploads + 1);
    expect(lastFace(key)).toContain('fleet');
    expect(lastFace(key)).not.toContain('why dark?');
  });
});
