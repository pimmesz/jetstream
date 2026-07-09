import { describe, it, expect } from 'vitest';
import { isReady } from './review';

describe('isReady', () => {
  it('is ready when CI is green or there is nothing to wait on', () => {
    expect(isReady({ url: 'https://example.test/pr/1', ci: 'green' })).toBe(true);
    expect(isReady({ url: 'https://example.test/pr/2', ci: 'none' })).toBe(true);
  });

  it('is not ready while CI is pending, red, or unknown', () => {
    expect(isReady({ url: 'https://example.test/pr/3', ci: 'pending' })).toBe(false);
    expect(isReady({ url: 'https://example.test/pr/4', ci: 'red' })).toBe(false);
    expect(isReady({ url: 'https://example.test/pr/5' })).toBe(false); // ci field absent
  });
});
