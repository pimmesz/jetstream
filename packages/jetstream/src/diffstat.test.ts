import { describe, expect, it } from 'vitest';
import { formatDiffStat, parseNumstat, readDiffStat } from './diffstat';

describe('parseNumstat', () => {
  it('sums added/deleted across multiple files', () => {
    const out = ['12\t3\tsrc/a.ts', '108\t37\tsrc/b.ts', '0\t1\tREADME.md'].join('\n');
    expect(parseNumstat(out)).toEqual({ added: 120, deleted: 41 });
  });

  it('skips binary rows (the `-\t-` columns) without throwing', () => {
    const out = ['10\t2\tsrc/a.ts', '-\t-\timgs/logo.png'].join('\n');
    expect(parseNumstat(out)).toEqual({ added: 10, deleted: 2 });
  });

  it('is zero for empty / whitespace / malformed output', () => {
    expect(parseNumstat('')).toEqual({ added: 0, deleted: 0 });
    expect(parseNumstat('\n\n')).toEqual({ added: 0, deleted: 0 });
    expect(parseNumstat('garbage with no tabs')).toEqual({ added: 0, deleted: 0 });
  });

  it('ignores non-plain-integer columns (negatives, scientific notation) instead of coercing', () => {
    // git never emits these, but the badge must not invent a count from surprising output.
    expect(parseNumstat('-3\t2\tfile\n1e3\t0\tother')).toEqual({ added: 0, deleted: 0 });
    expect(parseNumstat('5\t2\tok\n-3\t2\tbad')).toEqual({ added: 5, deleted: 2 });
  });
});

describe('readDiffStat', () => {
  it('parses the injected git output', async () => {
    const exec = async () => ({ stdout: '5\t2\tsrc/a.ts' });
    expect(await readDiffStat('/repo', exec)).toEqual({ added: 5, deleted: 2 });
  });

  it('returns null when git fails (non-repo / no HEAD / missing git)', async () => {
    const exec = async () => {
      throw new Error('fatal: not a git repository');
    };
    expect(await readDiffStat('/not-a-repo', exec)).toBeNull();
  });
});

describe('formatDiffStat', () => {
  it('renders +added/-deleted', () => {
    expect(formatDiffStat({ added: 120, deleted: 40 })).toBe('+120/-40');
  });

  it('is empty for null or a no-op change (nothing to badge)', () => {
    expect(formatDiffStat(null)).toBe('');
    expect(formatDiffStat({ added: 0, deleted: 0 })).toBe('');
  });
});
