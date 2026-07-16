import { describe, it, expect } from 'vitest';
import type { UsageFeed } from '@pimmesz/jetstream-usage';
import { gaugeColor } from './usage';

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
