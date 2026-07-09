import { describe, it, expect } from 'vitest';
import { heldMs } from './press';

describe('heldMs', () => {
  it('returns 0 when the key was never pressed', () => {
    expect(heldMs(new Map(), 'a', 1_000)).toBe(0);
  });

  it('returns the elapsed time since key-down', () => {
    const pressAt = new Map([['a', 1_000]]);
    expect(heldMs(pressAt, 'a', 1_650)).toBe(650);
  });

  it('clears the entry on read — a second up without a down reads 0', () => {
    const pressAt = new Map([['a', 1_000]]);
    heldMs(pressAt, 'a', 2_000);
    expect(pressAt.has('a')).toBe(false);
    expect(heldMs(pressAt, 'a', 3_000)).toBe(0);
  });

  it('only clears the released instance (an action can be placed more than once)', () => {
    const pressAt = new Map([
      ['a', 1_000],
      ['b', 1_200],
    ]);
    heldMs(pressAt, 'a', 2_000);
    expect(pressAt.get('b')).toBe(1_200);
  });
});
