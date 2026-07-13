import { describe, it, expect } from 'vitest';
import { shouldInterrupt } from './project';

describe('shouldInterrupt', () => {
  it('interrupts a working session held at or past the threshold', () => {
    expect(shouldInterrupt('working', 1500, 1500)).toBe(true);
    expect(shouldInterrupt('working', 2000, 1500)).toBe(true);
  });

  it('does not interrupt a working session released before the threshold (that opens the editor)', () => {
    expect(shouldInterrupt('working', 1499, 1500)).toBe(false);
    expect(shouldInterrupt('working', 0, 1500)).toBe(false);
  });

  it('never interrupts a non-working session, however long the hold', () => {
    for (const status of ['none', 'idle', 'needsInput', 'done'] as const) {
      expect(shouldInterrupt(status, 10_000, 1500)).toBe(false);
    }
  });
});
