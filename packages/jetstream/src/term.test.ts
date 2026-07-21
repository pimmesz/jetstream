import { afterEach, describe, expect, it, vi } from 'vitest';
import { paintCoordByRow, spinner } from './term';

const origIsTTY = process.stdout.isTTY;
const origNoColor = process.env.NO_COLOR;
afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  if (origNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = origNoColor;
});

const forceColorTTY = (): void => {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  delete process.env.NO_COLOR;
};

describe('paintCoordByRow', () => {
  it('is plain text off a colour TTY (piped output / tests)', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(paintCoordByRow('a1', 0)).toBe('a1');
  });
  it('wraps the coordinate in an ANSI colour keyed by row on a colour TTY', () => {
    forceColorTTY();
    const a = paintCoordByRow('a1', 0);
    expect(a).toContain('a1');
    expect(a).toMatch(/\x1b\[/); // carries an escape code
    expect(paintCoordByRow('b1', 1)).not.toBe(a); // a different row → a different colour band
    expect(paintCoordByRow('e1', 4)).toBe(a.replace('a1', 'e1')); // palette cycles (row 4 == row 0)
  });
});

describe('spinner', () => {
  it('off a colour TTY prints the label once and returns a no-op stop fn', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    // Assert the label actually reaches stdout — the test's own name promised "prints the label
    // once", but nothing checked it, so deleting the write left piped-output progress silent.
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const stop = spinner('thinking…');
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toContain('thinking…');
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
    } finally {
      write.mockRestore();
    }
  });
});
