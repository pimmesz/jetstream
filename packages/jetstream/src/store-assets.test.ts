import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorFor, glyphFor, type ProjectStatus } from '@pimmesz/jetstream-status';

// The store/marketing generator paints mock Stream Deck keys that people judge the product by.
// It used to restate the status palette as its own literal table, which silently drifted: every
// shipped gallery painted `working` in #e5484d — the red the status package reserves for danger
// and forbids as a status (see index.test.ts) — and `idle` in #0091ff, which is `done` in the
// high-contrast theme. The generator now imports colorFor, so the drift cannot recur by
// construction; these tests fail if someone reintroduces a hand-copied palette.
const SRC = join(__dirname, '..', 'scripts', 'gen-store-assets.mjs');
const src = readFileSync(SRC, 'utf8');
// The generator's prose explains the historical bug, so only look at real code.
const code = src
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

const STATUSES: ProjectStatus[] = ['working', 'needsInput', 'done', 'idle', 'none'];

// STATIC SOURCE CHECKS, not behavioural coverage. gen-store-assets.mjs is not importable (top-level
// Chrome side effects) and making it so was declined — the output is a marketplace gallery image
// reviewed by eye, not shipped code. So these assert one thing only: that the generator does not
// restate the palette. A wrong colour MAPPING still ships undetected; that gap is accepted.
describe('gen-store-assets palette (static source checks)', () => {
  it('imports colorFor instead of restating the palette', () => {
    expect(code).toMatch(/import \{[^}]*colorFor[^}]*\} from '@pimmesz\/jetstream-status'/);
    // Only the statuses the mock board actually renders must be read from the product (idle isn't lit here).
    for (const status of ['working', 'needsInput', 'done', 'none'] as ProjectStatus[]) {
      expect(code).toContain(`colorFor('${status}')`);
    }
  });

  it('hardcodes no default-theme status colour as a hex literal', () => {
    // Scoped to the default theme, which is what the mockups render. The non-status keys
    // (approve, model, launch presets) carry deliberate custom colours and must stay legal —
    // this guards the palette the generator claims to mirror, not every hex on the board.
    const statusHexes = new Set(STATUSES.map((s) => colorFor(s).toLowerCase()));
    const hexesInCode = (code.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase());
    // A literal that happens to equal a status colour is exactly the drift being guarded:
    // it reads as deliberate and silently decays the moment the palette moves.
    expect(hexesInCode.filter((h) => statusHexes.has(h))).toEqual([]);
  });

  it('mentions the reserved danger red only on stop-all lines, never a status', () => {
    // #e5484d is `stopFace`'s danger red (interrupt-all); the REAL stop-all key is red too, so the
    // mockup mirrors it. But it must never restate a project STATUS in that red (the old bug).
    const redLines = code.split('\n').filter((l) => l.includes('#e5484d'));
    // Guard the loop: with zero matches it runs zero times and the claim below is vacuous, so
    // recolouring the stop-all key would leave this test green while asserting nothing.
    expect(redLines.length).toBeGreaterThan(0);
    for (const line of redLines) {
      expect(line).toMatch(/stop all/i);
    }
    for (const status of STATUSES) {
      expect(colorFor(status)).not.toBe('#e5484d');
      expect(colorFor(status, 'highContrast')).not.toBe('#e5484d');
    }
  });

  it('does not restate status glyphs — ordinary keys mirror the product, where the glyph is exception-only', () => {
    // project-face reserves the corner glyph for a stall / failure / tool-showing key, so ordinary
    // lit keys carry none. The mockup must not paint decorative status glyphs (⋯ ! ✓) on them, and
    // must never fall back to a '...' lookalike where the product shows a single '⋯'.
    expect(code).not.toMatch(/glyphFor\(/);
    expect(code).not.toMatch(/glyph: '\.\.\.'/);
    expect(glyphFor('working')).toBe('⋯'); // product sanity: the real glyph is one char, not three dots
  });

  // REMOVED: a 32-cell count over `K(` / `BLANK` / `LOGO_CELL` / `TELEGRAM` tokens. It could not
  // fail for the reason it claimed — an inline cell not in that token list ships a 33-cell board
  // green — so it held a coverage slot without holding the invariant. Counting tokens is not
  // counting rendered cells; only looking at the PNG is.
});
