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
