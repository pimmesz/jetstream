import { join } from 'node:path';
import type { UsageFeed } from '@pimmesz/jetstream-usage';
import { describe, expect, it, vi } from 'vitest';
import { createCodexLivePoll, findCodex, LIVE_INTERVAL_MS } from './codex-live';

const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
const reading = (usedPct: number): UsageFeed => ({ source: 'codex', available: true, sevenDay: { usedPct } });

describe('finding codex outside a shell', () => {
  it('takes the first dir that holds codex', () => {
    const nvm = join('/', 'home', 'me', '.nvm', 'versions', 'node', 'v24.19.0', 'bin');
    const found = findCodex([join('/', 'usr', 'bin'), nvm, join('/', 'opt', 'homebrew', 'bin')], (p) => p !== join('/', 'usr', 'bin', binary));
    expect(found).toBe(join(nvm, binary));
  });

  it('never runs a codex from a relative PATH entry', () => {
    expect(findCodex(['.', 'bin', ''], () => true)).toBeUndefined();
  });
});

describe('the live Codex poll', () => {
  it('asks codex at most once per interval and keeps the reading in between', async () => {
    const read = vi.fn(async () => reading(1));
    const poll = createCodexLivePoll(read);
    expect(await poll(false, 0)).toEqual(reading(1));
    expect(await poll(false, LIVE_INTERVAL_MS - 1)).toEqual(reading(1));
    expect(read).toHaveBeenCalledTimes(1);
    await poll(false, LIVE_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a press asks right away, without waiting for the interval', async () => {
    const read = vi.fn(async () => reading(1));
    const poll = createCodexLivePoll(read);
    await poll(false, 0);
    await poll(true, 1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never runs two codex processes at once', async () => {
    let answer: (feed: UsageFeed) => void = () => {};
    const read = vi.fn(() => new Promise<UsageFeed | undefined>((resolve) => (answer = resolve)));
    const poll = createCodexLivePoll(read);
    const first = poll(true, 0);
    const second = poll(true, 1);
    answer(reading(5));
    expect(await first).toEqual(reading(5));
    expect(await second).toEqual(reading(5));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a failed read keeps the last good reading, so the logs are still compared with it', async () => {
    const read = vi.fn<() => Promise<UsageFeed | undefined>>().mockResolvedValueOnce(reading(3)).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('spawn'));
    const poll = createCodexLivePoll(read);
    await poll(true, 0);
    expect(await poll(true, 1)).toEqual(reading(3));
    expect(await poll(true, 2)).toEqual(reading(3));
  });
});
