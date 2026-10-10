import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  clampPct,
  parseClaudeStatusline,
  parseFeed,
  formatLine,
  resolveUsage,
  writeCache,
  readCache,
  writeSessionCache,
  readMergedCache,
  freshen,
  parseCodexRateLimits,
  resolveCodexUsage,
  type UsageFeed,
} from './index';

// Lets a prune test act as another session writing at an exact step, or make link fail.
const fsHooks = vi.hoisted(
  (): { beforeRename?: (to: string) => Promise<void>; beforeLink?: () => Promise<void>; linkError?: string } => ({}),
);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      await fsHooks.beforeRename?.(to);
      return fs.rename(from, to);
    },
    link: async (existing: string, newPath: string) => {
      await fsHooks.beforeLink?.();
      if (fsHooks.linkError) throw Object.assign(new Error(fsHooks.linkError), { code: fsHooks.linkError });
      return fs.link(existing, newPath);
    },
  };
});

beforeEach(() => {
  delete fsHooks.beforeRename;
  delete fsHooks.beforeLink;
  delete fsHooks.linkError;
});

describe('clampPct', () => {
  it('clamps to 0–100 and rejects non-finite', () => {
    expect(clampPct(42)).toBe(42);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(Number.NaN)).toBeUndefined();
    expect(clampPct('80')).toBeUndefined();
    expect(clampPct(undefined)).toBeUndefined();
  });
});

describe('parseClaudeStatusline', () => {
  it('parses both windows + model from a real payload shape', () => {
    expect(
      parseClaudeStatusline({
        model: { display_name: 'Opus' },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1000 },
          seven_day: { used_percentage: 41.2, resets_at: 2000 },
        },
      }),
    ).toEqual({
      source: 'claude',
      available: true,
      model: 'Opus',
      fiveHour: { usedPct: 23.5, resetsAt: 1000 },
      sevenDay: { usedPct: 41.2, resetsAt: 2000 },
    });
  });

  it('omits a window with no data and drops a non-finite reset', () => {
    expect(
      parseClaudeStatusline({ rate_limits: { seven_day: { used_percentage: 10 } } }),
    ).toEqual({ source: 'claude', available: true, sevenDay: { usedPct: 10 } });
  });

  it('degrades to unavailable on garbage rather than throwing', () => {
    expect(parseClaudeStatusline(null)).toEqual({
      source: 'claude',
      available: false,
      note: expect.any(String),
    });
    expect(parseClaudeStatusline({ rate_limits: {} }).available).toBe(false);
    expect(parseClaudeStatusline('nope').available).toBe(false);
  });
});

describe('parseFeed (cache round-trip / untrusted disk)', () => {
  it('rejects a shape missing required fields', () => {
    expect(parseFeed({ foo: 1 })).toBeNull();
    expect(parseFeed(null)).toBeNull();
  });

  it('round-trips a written feed', () => {
    const feed: UsageFeed = {
      source: 'claude',
      available: true,
      model: 'Sonnet',
      fiveHour: { usedPct: 5, resetsAt: 9 },
    };
    expect(parseFeed(JSON.parse(JSON.stringify(feed)))).toEqual(feed);
  });
});

describe('formatLine', () => {
  it('renders a compact line, empty when unavailable', () => {
    expect(
      formatLine({
        source: 'claude',
        available: true,
        model: 'Opus',
        fiveHour: { usedPct: 33.6 },
        sevenDay: { usedPct: 30 },
      }),
    ).toBe('Jetstream · Opus · 5h 34% · 7d 30%');
    expect(formatLine({ source: 'claude', available: false })).toBe('');
  });

  it('drops the model / a missing window from the line', () => {
    expect(
      formatLine({
        source: 'claude',
        available: true,
        fiveHour: { usedPct: 10 },
        sevenDay: { usedPct: 20 },
      }),
    ).toBe('Jetstream · 5h 10% · 7d 20%');
    expect(formatLine({ source: 'claude', available: true, fiveHour: { usedPct: 10 } })).toBe(
      'Jetstream · 5h 10%',
    );
    expect(formatLine({ source: 'claude', available: true, sevenDay: { usedPct: 20 } })).toBe(
      'Jetstream · 7d 20%',
    );
  });

  it('names a long window by its length when the source gives one (a Codex free plan runs 30 days)', () => {
    expect(formatLine({ source: 'codex', available: true, sevenDay: { usedPct: 40, windowMinutes: 43200 } })).toBe(
      'Jetstream · 30d 40%',
    );
    expect(formatLine({ source: 'codex', available: true, sevenDay: { usedPct: 40, windowMinutes: 10080 } })).toBe(
      'Jetstream · 7d 40%',
    );
  });
});

describe('writeCache / readCache', () => {
  it('round-trips a feed through an overridden cache path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const cachePath = join(dir, 'nested', 'usage.json'); // nested → exercises mkdir recursive
    const feed: UsageFeed = {
      source: 'claude',
      available: true,
      model: 'Opus',
      fiveHour: { usedPct: 12, resetsAt: 99 },
      sevenDay: { usedPct: 34 },
    };
    await writeCache(feed, cachePath);
    expect(await readCache(cachePath)).toEqual(feed);
  });

  it('readCache returns null for a missing file instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    expect(await readCache(join(dir, 'absent.json'))).toBeNull();
  });
});

describe('resolveUsage (statusline cache)', () => {
  const feed = (o: Partial<UsageFeed>): UsageFeed => ({ source: 'claude', available: true, ...o });

  it('returns the cache when available', async () => {
    const out = await resolveUsage({ readCacheFn: async () => feed({ model: 'cache' }) });
    expect(out.model).toBe('cache');
  });

  it('returns an explicit unavailable feed (with the install hint) when the cache is empty', async () => {
    const out = await resolveUsage({ readCacheFn: async () => null });
    expect(out.available).toBe(false);
    expect(out.note).toMatch(/install the Jetstream statusline hook/);
  });
});

describe('per-session snapshots', () => {
  it('merges sessions per window: the later reset wins, and within one window the higher reading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const legacy = join(dir, 'absent-usage.json');
    // The older session holds the higher weekly reading, so a merge differs from "take the newest snapshot".
    const a: UsageFeed = { source: 'claude', available: true, model: 'Opus', fiveHour: { usedPct: 40, resetsAt: 100 }, sevenDay: { usedPct: 30, resetsAt: 900 } };
    const b: UsageFeed = { source: 'claude', available: true, model: 'Sonnet', fiveHour: { usedPct: 5, resetsAt: 200 }, sevenDay: { usedPct: 22, resetsAt: 900 } };
    await writeSessionCache(a, 'session-a', dir, Date.now(), legacy);
    await writeSessionCache(b, 'session-b', dir, Date.now(), legacy);
    const minuteAgo = (Date.now() - 60_000) / 1000;
    await utimes(join(dir, 'session-a.json'), minuteAgo, minuteAgo); // an mtime tie would fall to listing order
    const merged = await readMergedCache(dir, legacy);
    expect(merged?.fiveHour).toEqual({ usedPct: 5, resetsAt: 200 }); // a newer 5h window started
    expect(merged?.sevenDay).toEqual({ usedPct: 30, resetsAt: 900 }); // same week: the higher reading
    expect(merged?.model).toBe('Sonnet'); // the most recently written session
  });

  it('stamps the merged feed with when its newest snapshot was written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const legacy = join(dir, 'absent-usage.json');
    const reading: UsageFeed = { source: 'claude', available: true, sevenDay: { usedPct: 30, resetsAt: 900 } };
    await writeSessionCache(reading, 'session-a', dir, Date.now(), legacy);
    await writeSessionCache(reading, 'session-b', dir, Date.now(), legacy);
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const minuteAgo = Math.floor(Date.now() / 1000) - 60;
    await utimes(join(dir, 'session-a.json'), hourAgo, hourAgo);
    await utimes(join(dir, 'session-b.json'), minuteAgo, minuteAgo);
    expect((await readMergedCache(dir, legacy))?.readAt).toBe(minuteAgo * 1000);
  });

  it('dates the merged feed by its oldest shown window, so a stale weekly reading is not passed off as fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const legacy = join(dir, 'absent-usage.json');
    await writeSessionCache({ source: 'claude', available: true, sevenDay: { usedPct: 52, resetsAt: 900 } }, 'old-weekly', dir, Date.now(), legacy);
    await writeSessionCache({ source: 'claude', available: true, fiveHour: { usedPct: 5, resetsAt: 200 } }, 'fresh-5h', dir, Date.now(), legacy);
    const fifteenHoursAgo = Math.floor(Date.now() / 1000) - 15 * 3600;
    const minuteAgo = Math.floor(Date.now() / 1000) - 60;
    await utimes(join(dir, 'old-weekly.json'), fifteenHoursAgo, fifteenHoursAgo);
    await utimes(join(dir, 'fresh-5h.json'), minuteAgo, minuteAgo);
    expect((await readMergedCache(dir, legacy))?.readAt).toBe(fifteenHoursAgo * 1000);
  });

  it('takes the model from the newest snapshot by mtime, not from whichever the folder lists last', async () => {
    const minuteAgo = (Date.now() - 60_000) / 1000;
    const snapshot = (id: string): UsageFeed => ({ source: 'claude', available: true, model: `model-${id}`, sevenDay: { usedPct: 10 } });
    // Same names, both mtime orders: whatever order readdir returns, one run lists the newer file first.
    for (const stale of ['a', 'z']) {
      const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
      const legacy = join(dir, 'absent-usage.json');
      for (const id of ['a', 'z']) await writeSessionCache(snapshot(id), id, dir, Date.now(), legacy);
      await utimes(join(dir, `${stale}.json`), minuteAgo, minuteAgo);
      const fresh = stale === 'a' ? 'z' : 'a';
      expect((await readMergedCache(dir, legacy))?.model, `${stale}.json back-dated`).toBe(`model-${fresh}`);
    }
  });

  it('drops snapshots older than eight days and refuses a session id that could leave the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const legacy = join(dir, 'legacy-usage.json');
    const feed: UsageFeed = { source: 'claude', available: true, sevenDay: { usedPct: 10 } };
    await writeSessionCache(feed, 'old', dir, Date.now(), legacy);
    const old = (Date.now() - 9 * 24 * 3600_000) / 1000;
    await utimes(join(dir, 'old.json'), old, old);
    await writeSessionCache(feed, 'new', dir, Date.now(), legacy);
    expect(await readCache(join(dir, 'old.json'))).toBeNull();
    await writeSessionCache(feed, '../escape', dir, Date.now(), legacy);
    expect(await readCache(join(dir, '..', 'escape.json'))).toBeNull();
    expect(await readCache(legacy)).toEqual(feed); // the fallback stays inside the test's folder
  });

  describe('a stale snapshot its session rewrites while it is being pruned', () => {
    const snapshot = (pct: number): string => JSON.stringify({ source: 'claude', available: true, sevenDay: { usedPct: pct, resetsAt: 2e9 } });
    const nineDaysAgo = (Date.now() - 9 * 24 * 3600_000) / 1000;
    const feed: UsageFeed = { source: 'claude', available: true, sevenDay: { usedPct: 20, resetsAt: 2e9 } };

    /** A folder holding one stale snapshot `s.json`, which its session rewrites to 50% just as the
     * prune moves it aside. */
    async function staleRewrittenOnMove(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
      await writeFile(join(dir, 's.json'), snapshot(10));
      await utimes(join(dir, 's.json'), nineDaysAgo, nineDaysAgo);
      let hasRewritten = false;
      fsHooks.beforeRename = async (to) => {
        if (hasRewritten || !to.includes('.prune-')) return;
        hasRewritten = true;
        await writeFile(join(dir, 's.json'), snapshot(50));
      };
      return dir;
    }

    it('puts the rewritten snapshot back instead of deleting it', async () => {
      const dir = await staleRewrittenOnMove();
      await writeSessionCache(feed, 'p', dir, Date.now(), join(dir, 'legacy.json'));
      expect(await readCache(join(dir, 's.json'))).toMatchObject({ sevenDay: { usedPct: 50 } });
      expect((await readdir(dir)).sort()).toEqual(['p.json', 's.json']);
    });

    it('keeps an even newer write that lands before the link back, and drops the aside copy', async () => {
      const dir = await staleRewrittenOnMove();
      fsHooks.beforeLink = async () => {
        delete fsHooks.beforeLink;
        await writeFile(join(dir, 's.json'), snapshot(60));
      };
      await writeSessionCache(feed, 'p', dir, Date.now(), join(dir, 'legacy.json'));
      expect(await readCache(join(dir, 's.json'))).toMatchObject({ sevenDay: { usedPct: 60 } });
      expect((await readdir(dir)).sort()).toEqual(['p.json', 's.json']);
    });

    it('keeps the rewritten snapshot under a .recovered name the reader still merges when the link back fails', async () => {
      const dir = await staleRewrittenOnMove();
      fsHooks.linkError = 'EPERM';
      await writeSessionCache(feed, 'p', dir, Date.now(), join(dir, 'legacy.json'));
      const names = await readdir(dir);
      expect(names.filter((n) => /^s\.recovered-[0-9a-f]+\.json$/.test(n))).toHaveLength(1);
      expect(names.some((n) => n.includes('.prune-'))).toBe(false);
      expect((await readMergedCache(dir, join(dir, 'legacy.json')))?.sevenDay?.usedPct).toBe(50);
    });

    it('removes a move-aside copy an interrupted prune left behind once it is old, and keeps a recent one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
      await writeFile(join(dir, 'old.json.prune-0a1b2c3d'), snapshot(10));
      await utimes(join(dir, 'old.json.prune-0a1b2c3d'), nineDaysAgo, nineDaysAgo);
      await writeFile(join(dir, 'new.json.prune-4e5f6a7b'), snapshot(10));
      await writeSessionCache(feed, 'p', dir, Date.now(), join(dir, 'legacy.json'));
      expect((await readdir(dir)).sort()).toEqual(['new.json.prune-4e5f6a7b', 'p.json']);
    });
  });

  it('removes temp files a dead render left behind, beside the snapshots and the legacy file, but keeps a fresh one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const home = await mkdtemp(join(tmpdir(), 'jetstream-usage-test-'));
    const tenMinutesAgo = (Date.now() - 10 * 60_000) / 1000;
    // Just inside the five-minute cutoff, so a lower threshold removes a temp a slow write still owns.
    const fourMinutesAgo = (Date.now() - 4 * 60_000) / 1000;
    const files = {
      [join(dir, 'dead.json.tmp-11-aaaaaaaa')]: tenMinutesAgo,
      [join(dir, 'live.json.tmp-12-bbbbbbbb')]: fourMinutesAgo,
      [join(home, 'usage.json.tmp-34167')]: tenMinutesAgo, // the older naming, pid only
      [join(home, 'usage.json.tmp-13-cccccccc')]: fourMinutesAgo,
      [join(home, 'board-state.json.tmp-14-dddddddd')]: tenMinutesAgo, // not the usage cache's to remove
    };
    for (const [path, mtime] of Object.entries(files)) {
      await writeFile(path, '{');
      await utimes(path, mtime, mtime);
    }
    const feed: UsageFeed = { source: 'claude', available: true, sevenDay: { usedPct: 10 } };
    await writeSessionCache(feed, 'p', dir, Date.now(), join(home, 'usage.json'));
    expect((await readdir(dir)).sort()).toEqual(['live.json.tmp-12-bbbbbbbb', 'p.json']);
    expect((await readdir(home)).sort()).toEqual(['board-state.json.tmp-14-dddddddd', 'usage.json.tmp-13-cccccccc']);
  });

  it('reports a window whose reset already passed as restarted (0%, no stale reset time)', () => {
    const now = 1_000_000_000;
    const out = freshen({ source: 'claude', available: true, fiveHour: { usedPct: 80, resetsAt: now / 1000 - 1 }, sevenDay: { usedPct: 30, resetsAt: now / 1000 + 60 } }, now);
    expect(out.fiveHour).toEqual({ usedPct: 0 });
    expect(out.sevenDay).toEqual({ usedPct: 30, resetsAt: now / 1000 + 60 });
  });
});

describe('Codex usage', () => {
  const event = (usedPct: number, minutes: number, resetsAt: number): string =>
    JSON.stringify({
      timestamp: '2026-10-06T20:04:09.669Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: { limit_id: 'codex', primary: { used_percent: usedPct, window_minutes: minutes, resets_at: resetsAt }, secondary: null, plan_type: 'pro' },
      },
    });

  it('maps the weekly and five-hour windows by length', () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 55, window_minutes: 10080, resets_at: 1791580923 }, secondary: null })).toEqual({
      source: 'codex',
      available: true,
      sevenDay: { usedPct: 55, resetsAt: 1791580923, windowMinutes: 10080 },
    });
    expect(
      parseCodexRateLimits({ primary: { used_percent: 12, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 2 } }),
    ).toMatchObject({ fiveHour: { usedPct: 12 }, sevenDay: { usedPct: 40 } });
    expect(parseCodexRateLimits({ primary: null, secondary: null }).available).toBe(false);
  });

  it('counts a window of exactly one day as the short one, and a minute longer as the long one', () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 12, window_minutes: 1440, resets_at: 1 } })).toMatchObject({ fiveHour: { usedPct: 12 } });
    expect(parseCodexRateLimits({ primary: { used_percent: 12, window_minutes: 1440, resets_at: 1 } }).sevenDay).toBeUndefined();
    expect(parseCodexRateLimits({ primary: { used_percent: 12, window_minutes: 1441, resets_at: 1 } })).toMatchObject({ sevenDay: { usedPct: 12 } });
    expect(parseCodexRateLimits({ primary: { used_percent: 12, window_minutes: 1441, resets_at: 1 } }).fiveHour).toBeUndefined();
  });

  it('reports a Codex window whose reset already passed as restarted, keeping how long it is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
    const day = join(root, '2026', '10', '06');
    await mkdir(day, { recursive: true });
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    // A free plan's monthly window that reset an hour ago while Codex sat idle.
    await writeFile(join(day, 'rollout-a.jsonl'), `${event(40, 43200, now / 1000 - 3600)}\n`);
    expect((await resolveCodexUsage({ sessionsDir: root, now })).sevenDay).toEqual({ usedPct: 0, windowMinutes: 43200 });
  });

  it('reads the newest rate limits from the most recently written session log, wherever its day folder is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
    const yesterday = join(root, '2026', '10', '05');
    const today = join(root, '2026', '10', '06');
    await mkdir(yesterday, { recursive: true });
    await mkdir(today, { recursive: true });
    const future = Math.floor(Date.now() / 1000) + 3600;
    // A session started yesterday is still the one writing now; today's file is older and stale.
    await writeFile(join(today, 'rollout-a.jsonl'), `${event(10, 10080, future)}\n`);
    await writeFile(join(yesterday, 'rollout-b.jsonl'), `partial line cut by the tail read\n${event(30, 10080, future)}\n${event(55, 10080, future)}\n{"type":"other"}\n`);
    const past = (Date.now() - 60_000) / 1000;
    await utimes(join(today, 'rollout-a.jsonl'), past, past);
    const feed = await resolveCodexUsage({ sessionsDir: root });
    expect(feed).toMatchObject({ source: 'codex', available: true, sevenDay: { usedPct: 55 } });
    // When Codex logged that reading, so the gauge can show its age.
    expect(feed.readAt).toBe(Date.parse('2026-10-06T20:04:09.669Z'));
  });

  it('finds a long-running session that started more than a week of folders ago', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
    const future = Math.floor(Date.now() / 1000) + 3600;
    const hour = 3600;
    // Nine newer day folders, each with an older, quieter session.
    for (let d = 10; d <= 18; d++) {
      const day = join(root, '2026', '09', String(d));
      await mkdir(day, { recursive: true });
      await writeFile(join(day, `rollout-${d}.jsonl`), `${event(10, 10080, future)}\n`);
      const old = Date.now() / 1000 - (30 - d) * hour;
      await utimes(join(day, `rollout-${d}.jsonl`), old, old);
    }
    // The session that is still running started first, in the oldest folder, and wrote just now.
    const first = join(root, '2026', '09', '01');
    await mkdir(first, { recursive: true });
    await writeFile(join(first, 'rollout-live.jsonl'), `${event(70, 10080, future)}\n`);
    expect(await resolveCodexUsage({ sessionsDir: root })).toMatchObject({ sevenDay: { usedPct: 70 } });
  });

  it('takes the reading logged last, not the file written last', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
    const day = join(root, '2026', '10', '06');
    await mkdir(day, { recursive: true });
    const future = Math.floor(Date.now() / 1000) + 3600;
    const at = (iso: string, pct: number): string => event(pct, 10080, future).replace('2026-10-06T20:04:09.669Z', iso);
    // Session B logged 55% later; session A logged 10% earlier but then appended tool output, so its file is newer.
    await writeFile(join(day, 'rollout-b.jsonl'), `${at('2026-10-06T20:00:00.000Z', 55)}\n`);
    await writeFile(join(day, 'rollout-a.jsonl'), `${at('2026-10-06T19:00:00.000Z', 10)}\n{"type":"response_item","payload":{}}\n`);
    const older = (Date.now() - 60_000) / 1000;
    await utimes(join(day, 'rollout-b.jsonl'), older, older);
    expect(await resolveCodexUsage({ sessionsDir: root })).toMatchObject({ sevenDay: { usedPct: 55 } });
  });

  describe('per-model buckets (limit_id other than codex) are not the account', () => {
    // Codex also logs a bucket per model (GPT-5.3-Codex-Spark, always at 0%) next to the account's.
    const line = (iso: string, limits: Record<string, unknown>): string =>
      JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: limits } });
    const future = Math.floor(Date.now() / 1000) + 3600;
    const account = { limit_id: 'codex', primary: { used_percent: 72, window_minutes: 10080, resets_at: future }, secondary: null };
    const spark = {
      limit_id: 'codex_bengalfox',
      limit_name: 'GPT-5.3-Codex-Spark',
      primary: { used_percent: 0, window_minutes: 300, resets_at: future },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: future },
    };

    it('reads past model buckets logged after the account bucket in the same file', async () => {
      const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
      const day = join(root, '2026', '09', '13');
      await mkdir(day, { recursive: true });
      const lines = [line('2026-09-13T08:00:00Z', account), line('2026-09-13T08:54:51Z', spark), line('2026-09-13T08:54:59Z', spark)];
      await writeFile(join(day, 'rollout-a.jsonl'), `${lines.join('\n')}\n`);
      const feed = await resolveCodexUsage({ sessionsDir: root });
      expect(feed.sevenDay).toMatchObject({ usedPct: 72 });
      expect(feed.fiveHour).toBeUndefined();
    });

    it('skips a newer session that logged only model buckets', async () => {
      const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
      const day = join(root, '2026', '09', '13');
      await mkdir(day, { recursive: true });
      await writeFile(join(day, 'rollout-main.jsonl'), `${line('2026-09-13T10:05:00Z', account)}\n`);
      await writeFile(join(day, 'rollout-review.jsonl'), `${line('2026-09-13T10:07:00Z', spark)}\n`);
      const older = (Date.now() - 60_000) / 1000;
      await utimes(join(day, 'rollout-main.jsonl'), older, older);
      expect(await resolveCodexUsage({ sessionsDir: root })).toMatchObject({ sevenDay: { usedPct: 72 } });
    });

    it('looks past eight newer sessions that logged only model buckets', async () => {
      const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
      const day = join(root, '2026', '09', '13');
      await mkdir(day, { recursive: true });
      await writeFile(join(day, 'rollout-main.jsonl'), `${line('2026-09-13T10:05:00Z', account)}\n`);
      const older = (Date.now() - 60_000) / 1000;
      await utimes(join(day, 'rollout-main.jsonl'), older, older);
      for (let i = 0; i < 8; i++) {
        await writeFile(join(day, `rollout-review-${i}.jsonl`), `${line('2026-09-13T10:07:00Z', spark)}\n`);
      }
      expect(await resolveCodexUsage({ sessionsDir: root })).toMatchObject({ sevenDay: { usedPct: 72 } });
    });

    it('still reads an older log line that has no limit_id as the account', async () => {
      const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
      const day = join(root, '2026', '09', '13');
      await mkdir(day, { recursive: true });
      const { limit_id: _id, ...unnamed } = account;
      await writeFile(join(day, 'rollout-a.jsonl'), `${line('2026-09-13T08:00:00Z', unnamed)}\n`);
      expect(await resolveCodexUsage({ sessionsDir: root })).toMatchObject({ sevenDay: { usedPct: 72 } });
    });
  });

  it('keeps a reading already found when another candidate cannot be opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jetstream-codex-'));
    const day = join(root, '2026', '10', '06');
    await mkdir(day, { recursive: true });
    const future = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(join(day, 'rollout-good.jsonl'), `${event(55, 10080, future)}\n`);
    // A directory with a rollout name: listed and stat-able, but open() for reading fails.
    await mkdir(join(day, 'rollout-broken.jsonl'));
    const older = (Date.now() - 60_000) / 1000;
    await utimes(join(day, 'rollout-broken.jsonl'), older, older);
    expect(await resolveCodexUsage({ sessionsDir: root })).toMatchObject({ available: true, sevenDay: { usedPct: 55 } });
  });

  it('says so instead of throwing when Codex has never run', async () => {
    const feed = await resolveCodexUsage({ sessionsDir: join(tmpdir(), 'jetstream-no-codex-here') });
    expect(feed).toMatchObject({ source: 'codex', available: false });
  });
});
