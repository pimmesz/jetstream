import { describe, it, expect } from 'vitest';
import { keyFace, fit, formatElapsed, formatReset } from './render';

describe('keyFace', () => {
  it('renders a data:image/svg+xml URI with the colour and label', () => {
    const uri = keyFace({ color: '#e5484d', label: 'falcon', sub: 'working 4m' });
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('fill="#e5484d"');
    expect(svg).toContain('falcon');
    expect(svg).toContain('working 4m');
  });

  it('escapes markup in labels (untrusted settings text)', () => {
    const svg = decodeURIComponent(
      keyFace({ color: '#000000', label: '<script>' }).slice('data:image/svg+xml,'.length),
    );
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script');
  });
});

describe('fit', () => {
  it('truncates long labels with an ellipsis', () => {
    expect(fit('afterburner', 10)).toBe('afterburn…');
    expect(fit('falcon', 10)).toBe('falcon');
  });
});

describe('formatElapsed', () => {
  it('formats minutes and hours, min 1m', () => {
    expect(formatElapsed(30_000)).toBe('1m');
    expect(formatElapsed(4 * 60_000)).toBe('4m');
    expect(formatElapsed(72 * 60_000)).toBe('1h12m');
    expect(formatElapsed(120 * 60_000)).toBe('2h');
    expect(formatElapsed(Number.NaN)).toBe('1m');
  });
});

describe('formatReset', () => {
  it('counts down to an epoch-seconds reset', () => {
    const now = 1_000_000_000_000;
    expect(formatReset(now / 1000 + 134 * 60, now)).toBe('2h14m');
    expect(formatReset(now / 1000 + 60, now)).toBe('1m');
    expect(formatReset(now / 1000 + 3 * 24 * 3600, now)).toBe('3d');
    expect(formatReset(now / 1000 - 10, now)).toBe('');
    expect(formatReset(undefined, now)).toBe('');
  });
});
