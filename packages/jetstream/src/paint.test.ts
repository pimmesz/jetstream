import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAllPainted, forgetPainted, paintKey } from './paint';

const fakeKey = (id: string) => ({ id, setImage: vi.fn(async (_image: string) => {}) });

beforeEach(() => forgetAllPainted());

describe('paintKey', () => {
  it('uploads the first face, then skips an identical repaint', async () => {
    const a = fakeKey('k1');
    await paintKey(a, 'face-A');
    await paintKey(a, 'face-A');
    await paintKey(a, 'face-A');
    // The whole point: renderAll runs on every board change + a 30s tick, and Stream Deck
    // re-rasterises on each setImage — that redundant upload is the visible flicker.
    expect(a.setImage).toHaveBeenCalledTimes(1);
  });

  it('repaints as soon as the face actually changes', async () => {
    const a = fakeKey('k1');
    await paintKey(a, 'face-A');
    await paintKey(a, 'face-B');
    expect(a.setImage).toHaveBeenCalledTimes(2);
    expect(a.setImage).toHaveBeenLastCalledWith('face-B');
  });

  it('tracks keys independently', async () => {
    const a = fakeKey('k1');
    const b = fakeKey('k2');
    await paintKey(a, 'same');
    await paintKey(b, 'same'); // b has never been painted, so it must upload
    expect(a.setImage).toHaveBeenCalledTimes(1);
    expect(b.setImage).toHaveBeenCalledTimes(1);
  });

  it('forgetPainted forces the next paint — a re-appearing key must not stay blank', async () => {
    const a = fakeKey('k1');
    await paintKey(a, 'face-A');
    forgetPainted(a.id); // the deck cleared this key (profile switch / page nav / reconnect)
    await paintKey(a, 'face-A');
    expect(a.setImage).toHaveBeenCalledTimes(2);
  });

  it('forgetPainted during an in-flight paint does not let two paints race', async () => {
    // Dropping the chain here would detach the in-flight paint, so the next one runs CONCURRENTLY
    // and whichever settles last wins — the key could end up on the older face.
    const a = fakeKey('k1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    a.setImage.mockImplementationOnce(() => gate);
    const first = paintKey(a, 'old'); // in flight
    forgetPainted(a.id); // profile switch lands mid-upload
    const second = paintKey(a, 'new');
    release();
    await Promise.all([first, second]);
    expect(a.setImage).toHaveBeenLastCalledWith('new'); // ordering preserved, newest wins
  });

  // The cache's one dangerous failure mode, and the reason every transient face (fleet's
  // "why dark?", project's "release to interrupt") must go THROUGH paintKey rather than a raw
  // setImage: a raw upload leaves the cache remembering the pre-transient face, so the revert
  // paints an "identical" face, is skipped, and strands the key on the transient forever.
  it('a raw setImage behind its back strands the key — the reason transients use paintKey', async () => {
    const a = fakeKey('k1');
    await paintKey(a, 'steady');
    await a.setImage('transient'); // simulating the bug: bypasses the cache
    await paintKey(a, 'steady'); // the revert
    expect(a.setImage).toHaveBeenCalledTimes(2); // NOT 3 — the revert was skipped, key stuck
    expect(a.setImage).toHaveBeenLastCalledWith('transient');
  });

  it('a revert requested DURING an in-flight transient still lands', async () => {
    // The race the serialization exists for: comparing against the cache while an upload is still
    // in flight reads a face that is already out of date, so the revert would match the
    // pre-transient face, be skipped, and leave the transient as the last thing on the key.
    const a = fakeKey('k1');
    await paintKey(a, 'steady');
    // A gate the test controls, created up front — paintKey defers the setImage call into its
    // chain, so capturing the resolver from inside the mock would deadlock.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    a.setImage.mockImplementationOnce(() => gate);
    const transient = paintKey(a, 'warning'); // in flight, cache still says 'steady'
    const revert = paintKey(a, 'steady'); // must NOT compare against the stale 'steady'
    release();
    await Promise.all([transient, revert]);
    expect(a.setImage).toHaveBeenLastCalledWith('steady');
    expect(a.setImage).toHaveBeenCalledTimes(3);
  });

  it('one key failing does not wedge that key forever', async () => {
    const a = fakeKey('k1');
    a.setImage.mockRejectedValueOnce(new Error('deck disconnected'));
    await expect(paintKey(a, 'face-A')).rejects.toThrow();
    await paintKey(a, 'face-B'); // the chain must still accept work after a rejection
    expect(a.setImage).toHaveBeenLastCalledWith('face-B');
  });

  it('a transient painted through paintKey reverts correctly', async () => {
    const a = fakeKey('k1');
    await paintKey(a, 'steady');
    await paintKey(a, 'transient');
    await paintKey(a, 'steady');
    expect(a.setImage).toHaveBeenCalledTimes(3);
    expect(a.setImage).toHaveBeenLastCalledWith('steady');
  });

  it('does NOT remember a face whose upload failed, so the next render retries', async () => {
    const a = fakeKey('k1');
    a.setImage.mockRejectedValueOnce(new Error('deck disconnected'));
    await expect(paintKey(a, 'face-A')).rejects.toThrow('deck disconnected');
    await paintKey(a, 'face-A'); // same face — must still be attempted
    expect(a.setImage).toHaveBeenCalledTimes(2);
  });
});
