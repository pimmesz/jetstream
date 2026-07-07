import { describe, it, expect } from 'vitest';
import {
  clampPct,
  parseClaudeStatusline,
  parseAfterburnerJson,
  parseFeed,
  formatLine,
  resolveUsage,
  type UsageFeed,
} from './index';

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

describe('parseAfterburnerJson', () => {
  it('maps afterburner`s feed-shaped JSON', () => {
    expect(
      parseAfterburnerJson({
        source: 'codex',
        available: true,
        fiveHour: { usedPct: 43, resetsAt: 111 },
        sevenDay: { usedPct: 72, resetsAt: 222 },
      }),
    ).toEqual({
      source: 'codex',
      available: true,
      fiveHour: { usedPct: 43, resetsAt: 111 },
      sevenDay: { usedPct: 72, resetsAt: 222 },
    });
  });

  it('honors available:false even if a window sneaks in', () => {
    expect(parseAfterburnerJson({ source: 'codex', available: false, note: 'x' }).available).toBe(
      false,
    );
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
});

describe('resolveUsage (fallback chain)', () => {
  const feed = (o: Partial<UsageFeed>): UsageFeed => ({ source: 'claude', available: true, ...o });

  it('prefers the cache when available', async () => {
    const out = await resolveUsage({
      readCacheFn: async () => feed({ model: 'cache' }),
      afterburnerFn: async () => feed({ model: 'ab' }),
    });
    expect(out.model).toBe('cache');
  });

  it('falls back to afterburner when the cache is empty', async () => {
    const out = await resolveUsage({
      readCacheFn: async () => null,
      afterburnerFn: async () => feed({ model: 'ab' }),
    });
    expect(out.model).toBe('ab');
  });

  it('returns an explicit unavailable feed when nothing is readable', async () => {
    const out = await resolveUsage({
      readCacheFn: async () => null,
      afterburnerFn: async () => null,
    });
    expect(out.available).toBe(false);
    expect(out.note).toMatch(/install the Jetstream statusline hook/);
  });
});
