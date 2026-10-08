import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../mic-control');
import { readInputVolume, writeInputVolume } from '../mic-control';
import { MicMuteKey, micFace } from './micmute';

beforeEach(() => {
  vi.mocked(readInputVolume).mockReset();
  vi.mocked(writeInputVolume).mockReset();
});

describe('micFace', () => {
  it('muted → red MUTED; live → dark mic; unavailable → n/a', () => {
    expect(micFace(true, true)).toMatchObject({ color: '#e5484d', label: 'MUTED', emoji: '🎙' });
    expect(micFace(false, true)).toMatchObject({ label: 'mic', emoji: '🎙' });
    expect(micFace(false, false)).toMatchObject({ sub: 'n/a' });
  });
});

const fakeKey = () => ({
  isKey: () => true,
  setImage: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
  showAlert: vi.fn(async () => {}),
});
const press = (mic: MicMuteKey, action: ReturnType<typeof fakeKey>) =>
  mic.onKeyDown({ action } as unknown as Parameters<MicMuteKey['onKeyDown']>[0]);

describe('MicMuteKey.onKeyDown', () => {
  it('mutes to 0 when live, then restores the captured level on the next press', async () => {
    const mic = new MicMuteKey();
    const a = fakeKey();
    vi.mocked(readInputVolume).mockResolvedValue(72); // live at 72
    await press(mic, a);
    expect(writeInputVolume).toHaveBeenCalledWith(0);

    vi.mocked(writeInputVolume).mockClear();
    vi.mocked(readInputVolume).mockResolvedValue(0); // now muted
    await press(mic, a);
    expect(writeInputVolume).toHaveBeenCalledWith(72); // restores the captured pre-mute level
  });

  it('alerts and changes nothing when the OS reports no input volume', async () => {
    const mic = new MicMuteKey();
    const a = fakeKey();
    vi.mocked(readInputVolume).mockResolvedValue(undefined);
    await press(mic, a);
    expect(a.showAlert).toHaveBeenCalled();
    expect(writeInputVolume).not.toHaveBeenCalled();
  });

  it('a board repaint whose read started before a toggle never paints over the toggle', async () => {
    const mic = new MicMuteKey();
    const a = fakeKey();
    Object.defineProperty(mic, 'actions', { value: [a], configurable: true });
    let resolveStale!: (v: number) => void;
    const staleRead = new Promise<number>((r) => (resolveStale = r));
    // renderAll's read is slow and sees the old muted level; the toggle then unmutes and paints 'mic'.
    vi.mocked(readInputVolume).mockReturnValueOnce(staleRead).mockResolvedValueOnce(0).mockResolvedValue(75);
    const repaint = mic.renderAll();
    await press(mic, a);
    const paintsAfterToggle = a.setImage.mock.calls.length;
    resolveStale(0);
    await repaint;
    expect(a.setImage.mock.calls.length).toBe(paintsAfterToggle); // the stale MUTED face was dropped
  });

  it('a repaint whose read starts while the toggle is still writing does not paint the old state', async () => {
    const mic = new MicMuteKey();
    const a = fakeKey();
    Object.defineProperty(mic, 'actions', { value: [a], configurable: true });
    let finishWrite!: () => void;
    const writing = new Promise<void>((r) => (finishWrite = r));
    vi.mocked(writeInputVolume).mockReturnValueOnce(writing);
    let resolveStale!: (v: number) => void;
    const staleRead = new Promise<number>((r) => (resolveStale = r));
    // toggle reads muted (0); the repaint's read starts mid-write and sees 0 too; the toggle's own read sees 75.
    vi.mocked(readInputVolume).mockResolvedValueOnce(0).mockReturnValueOnce(staleRead).mockResolvedValue(75);
    const toggle = press(mic, a);
    await Promise.resolve();
    await Promise.resolve();
    const repaint = mic.renderAll(); // starts while the write is pending
    finishWrite();
    await toggle;
    const paintsAfterToggle = a.setImage.mock.calls.length;
    resolveStale(0);
    await repaint;
    expect(a.setImage.mock.calls.length).toBe(paintsAfterToggle);
  });

  it('drops a second press while the first toggle is still in flight (no double-mute)', async () => {
    const mic = new MicMuteKey();
    const a = fakeKey();
    let resolveRead!: (v: number) => void;
    const gate = new Promise<number>((r) => (resolveRead = r));
    // First read (the toggle) blocks on the gate; any later read (the post-toggle render) sees 0/muted.
    vi.mocked(readInputVolume).mockReturnValueOnce(gate).mockResolvedValue(0);
    const first = press(mic, a); // enters the toggle, blocks on readInputVolume
    const second = press(mic, a); // must be ignored — a toggle is in flight
    resolveRead(72); // let the first toggle complete
    await Promise.all([first, second]);
    expect(writeInputVolume).toHaveBeenCalledTimes(1); // exactly one toggle happened
    expect(writeInputVolume).toHaveBeenCalledWith(0);
  });
});
