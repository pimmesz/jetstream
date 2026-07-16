import { describe, it, expect, vi } from 'vitest';
import { selectOne, selectMany } from './select';

// In vitest stdin/stdout aren't TTYs, so selectOne takes the numbered-list fallback — which is also
// the piped-input path in production. That's the branch these tests exercise.
const rlWith = (answers: string[]) => {
  let i = 0;
  return { question: vi.fn(async () => answers[i++] ?? '') };
};

const choices = [
  { label: 'Apply', value: 'apply' },
  { label: 'Refine', value: 'refine' },
  { label: 'Cancel', value: 'cancel' },
];

describe('selectOne (numbered fallback)', () => {
  it('returns the value for the chosen number', async () => {
    expect(await selectOne(rlWith(['2']), 'Apply this?', choices)).toBe('refine');
  });
  it('empty input picks the default index', async () => {
    expect(await selectOne(rlWith(['']), 'Apply this?', choices, 2)).toBe('cancel');
  });
  it('re-asks on an out-of-range or non-numeric answer', async () => {
    const rl = rlWith(['9', 'abc', '1']);
    expect(await selectOne(rl, 'Apply this?', choices)).toBe('apply');
    expect(rl.question).toHaveBeenCalledTimes(3);
  });
  it('throws for an empty choice list', async () => {
    await expect(selectOne(rlWith([]), 'x', [])).rejects.toThrow();
  });
});

describe('selectMany (numbered fallback)', () => {
  it('returns the picked values IN PICK ORDER, not list order', async () => {
    expect(await selectMany(rlWith(['3,1']), 'Pick', choices)).toEqual(['cancel', 'apply']);
  });
  it("'all' selects everything in list order", async () => {
    expect(await selectMany(rlWith(['all']), 'Pick', choices)).toEqual(['apply', 'refine', 'cancel']);
  });
  it('empty input selects nothing', async () => {
    expect(await selectMany(rlWith(['']), 'Pick', choices)).toEqual([]);
  });
  it('drops junk, out-of-range, and duplicate numbers', async () => {
    expect(await selectMany(rlWith(['2, 2, 9, x, 1']), 'Pick', choices)).toEqual(['refine', 'apply']);
  });
  it('returns [] for an empty choice list without asking', async () => {
    const rl = rlWith([]);
    expect(await selectMany(rl, 'Pick', [])).toEqual([]);
    expect(rl.question).not.toHaveBeenCalled();
  });
});
