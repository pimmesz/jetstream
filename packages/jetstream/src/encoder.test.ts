import { describe, it, expect } from 'vitest';
import { scrubIndex, dialFeedback } from './encoder';
import { colorFor } from '@pimmesz/jetstream-status';

describe('scrubIndex', () => {
  it('wraps around both ends', () => {
    expect(scrubIndex(3, 0, 1)).toBe(1);
    expect(scrubIndex(3, 2, 1)).toBe(0); // clockwise past the last → first
    expect(scrubIndex(3, 0, -1)).toBe(2); // counter-clockwise past the first → last
  });

  it('handles multi-tick jumps and large deltas', () => {
    expect(scrubIndex(5, 0, 7)).toBe(2); // (0+7)%5
    expect(scrubIndex(5, 3, -9)).toBe(4); // (((3-9)%5)+5)%5
  });

  it('never indexes out of range for an empty fleet', () => {
    expect(scrubIndex(0, 0, 1)).toBe(0);
    expect(scrubIndex(0, 5, -3)).toBe(0);
  });
});

describe('dialFeedback', () => {
  const now = 1_000_000;

  it('shows an invitation when nothing is selected (empty fleet)', () => {
    const fb = dialFeedback(undefined, { status: 'none' }, now);
    expect(fb.title).toBe('Fleet');
    expect(fb.value).toMatch(/settings/);
  });

  it('renders name + coloured status for the selected project', () => {
    const fb = dialFeedback({ name: 'afterburner' }, { status: 'needsInput' }, now);
    expect(fb.title).toBe('afterburner');
    expect(fb.value).toBe('needs you');
    expect(fb.color).toBe(colorFor('needsInput'));
  });

  it('includes the tool + elapsed while working', () => {
    const fb = dialFeedback({ name: 'x' }, { status: 'working', tool: 'Bash', since: now - 60_000 }, now);
    expect(fb.value).toMatch(/^Bash · /);
  });

  it('shows a done elapsed', () => {
    const fb = dialFeedback({ name: 'x' }, { status: 'done', since: now - 240_000 }, now);
    expect(fb.value).toMatch(/^done /);
    expect(fb.color).toBe(colorFor('done'));
  });

  it('respects the high-contrast theme', () => {
    const fb = dialFeedback({ name: 'x' }, { status: 'working', since: now }, now, 'highContrast');
    expect(fb.color).toBe(colorFor('working', 'highContrast'));
  });
});
