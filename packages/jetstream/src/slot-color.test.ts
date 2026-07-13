import { describe, it, expect } from 'vitest';
import { normalizeColor } from './slot-color';

describe('normalizeColor', () => {
  it('passes 6-digit hex, expands 3-digit, maps known names (case/space-insensitive)', () => {
    expect(normalizeColor('#e5484d')).toBe('#e5484d');
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor('red')).toBe('#e5484d');
    expect(normalizeColor('Spotify Green')).toBe('#1db954');
    expect(normalizeColor('  PURPLE ')).toBe('#7c5cff');
  });
  it('undefined for an unknown name or malformed hex', () => {
    expect(normalizeColor('mauve')).toBeUndefined();
    expect(normalizeColor('#12')).toBeUndefined();
    expect(normalizeColor('#gggggg')).toBeUndefined();
    expect(normalizeColor('')).toBeUndefined();
  });
});
