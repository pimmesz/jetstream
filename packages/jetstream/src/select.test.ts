import { describe, it, expect, vi } from 'vitest';
import { selectOne } from './select';

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
