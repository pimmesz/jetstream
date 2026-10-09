import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectState } from '@pimmesz/jetstream-status';
import { InterruptAllKey } from './interrupt-all';
import { board } from '../state';
import { forgetAllPainted, forgetPainted } from '../paint';

vi.mock('../stop-session'); // spy stopSessions: no real session is signalled
import { stopSessions } from '../stop-session';

/** A visible stop-all key whose setImage records each upload. */
function fakeKey(id: string) {
  return {
    id,
    isKey: () => true,
    setImage: vi.fn(async (_img: string) => {}),
    setTitle: vi.fn(async () => {}),
    showOk: vi.fn(async () => {}),
    showAlert: vi.fn(async () => {}),
  };
}

const working = (n: number): Record<string, ProjectState> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { status: 'working' }]));

const lastFace = (key: ReturnType<typeof fakeKey>): string =>
  decodeURIComponent(key.setImage.mock.calls.at(-1)?.[0] ?? '');

describe('InterruptAllKey "stopping" notice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forgetAllPainted();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('owns the key until it expires, then the live working-count returns', async () => {
    vi.mocked(stopSessions).mockReturnValue(2);
    const byProject = vi.spyOn(board, 'byProject').mockReturnValue(working(2));
    const key = fakeKey('stop-1');
    const stopAll = new InterruptAllKey();
    Object.defineProperty(stopAll, 'actions', { value: [key], configurable: true });

    await stopAll.onKeyDown({ action: key } as unknown as Parameters<InterruptAllKey['onKeyDown']>[0]);
    expect(lastFace(key)).toContain('stopping');

    // A board emit mid-notice (the turns have not ended yet) must not repaint "2 working" over it.
    await vi.advanceTimersByTimeAsync(1000);
    await stopAll.renderAll();
    expect(lastFace(key)).toContain('stopping');

    // The turns end; once the notice clears the key shows the live face without waiting for a tick.
    byProject.mockReturnValue({});
    await vi.advanceTimersByTimeAsync(1700);
    expect(lastFace(key)).toContain('idle');
    expect(lastFace(key)).not.toContain('stopping');
  });

  it('still reverts when the timer fires 1 ms before the clock reaches the deadline', async () => {
    vi.mocked(stopSessions).mockReturnValue(2);
    vi.spyOn(board, 'byProject').mockReturnValue({});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const key = fakeKey('stop-early');
    const stopAll = new InterruptAllKey();
    Object.defineProperty(stopAll, 'actions', { value: [key], configurable: true });

    await stopAll.onKeyDown({ action: key } as unknown as Parameters<InterruptAllKey['onKeyDown']>[0]);
    expect(lastFace(key)).toContain('stopping');

    now.mockReturnValue(1_000_000 + 2600 - 1);
    await vi.advanceTimersByTimeAsync(2600);
    expect(lastFace(key)).toContain('idle');
    expect(lastFace(key)).not.toContain('stopping');
  });

  it('a second press during the notice keeps the newer notice past the first timer', async () => {
    vi.mocked(stopSessions).mockReturnValue(2);
    vi.spyOn(board, 'byProject').mockReturnValue({});
    const key = fakeKey('stop-twice');
    const stopAll = new InterruptAllKey();
    Object.defineProperty(stopAll, 'actions', { value: [key], configurable: true });
    const press = () => stopAll.onKeyDown({ action: key } as unknown as Parameters<InterruptAllKey['onKeyDown']>[0]);

    await press();
    await vi.advanceTimersByTimeAsync(1000);
    await press();

    // The first press's timer fires; the second press still owns the key for another second.
    await vi.advanceTimersByTimeAsync(1700);
    expect(lastFace(key)).toContain('stopping');

    await vi.advanceTimersByTimeAsync(1000);
    expect(lastFace(key)).toContain('idle');
    expect(lastFace(key)).not.toContain('stopping');
  });

  it('a key that reappears mid-notice paints the live face at once', async () => {
    vi.mocked(stopSessions).mockReturnValue(2);
    vi.spyOn(board, 'byProject').mockReturnValue(working(2));
    const key = fakeKey('stop-back');
    const stopAll = new InterruptAllKey();
    Object.defineProperty(stopAll, 'actions', { value: [key], configurable: true });

    await stopAll.onKeyDown({ action: key } as unknown as Parameters<InterruptAllKey['onKeyDown']>[0]);
    expect(lastFace(key)).toContain('stopping');

    // Page away and back mid-notice: the deck blanks the key, and plugin.ts forgets its painted face.
    await vi.advanceTimersByTimeAsync(1000);
    forgetPainted(key.id);
    const uploads = key.setImage.mock.calls.length;
    stopAll.onWillAppear({ action: key } as unknown as Parameters<InterruptAllKey['onWillAppear']>[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(key.setImage.mock.calls.length).toBe(uploads + 1);
    expect(lastFace(key)).toContain('2 working');
    expect(lastFace(key)).not.toContain('stopping');
  });
});
