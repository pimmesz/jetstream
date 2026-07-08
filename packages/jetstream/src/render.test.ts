import { describe, it, expect } from 'vitest';
import { keyFace, fit, formatElapsed, formatReset, formatNextReset } from './render';

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

  it('subMax keeps a longer sub legible (E: the pending command line) at a smaller font', () => {
    const long = 'Bash: rm -rf dist/build';
    const decode = (uri: string) => decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    // Default budget (14) cuts the command off at font-size 18 — the full path is lost.
    const dflt = decode(keyFace({ color: '#000', label: 'APPROVE', sub: long }));
    expect(dflt).not.toContain('dist/build');
    expect(dflt).toContain('font-size="18"');
    // A larger budget shows the whole command at a smaller font (14).
    const wide = decode(keyFace({ color: '#000', label: 'APPROVE', sub: long, subMax: 24 }));
    expect(wide).toContain('rm -rf dist/build');
    expect(wide).toContain('font-size="14"');
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

describe('formatNextReset', () => {
  const now = 1_000_000_000_000;
  const inHours = (h: number) => now / 1000 + h * 3600;

  it('labels the SOONER of the 5h/7d resets', () => {
    // 7d window resets in 2h, 5h in 3h → the 7d one bites next.
    expect(formatNextReset(inHours(3), inHours(2), now)).toBe('resets 2h');
    expect(formatNextReset(inHours(1), inHours(40), now)).toBe('resets 1h');
  });

  it('ignores a window that has already passed, and is empty when neither is in the future', () => {
    expect(formatNextReset(inHours(-1), inHours(5), now)).toBe('resets 5h');
    expect(formatNextReset(inHours(-1), inHours(-2), now)).toBe('');
    expect(formatNextReset(undefined, undefined, now)).toBe('');
  });
});
