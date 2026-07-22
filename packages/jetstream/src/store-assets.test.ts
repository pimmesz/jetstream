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

describe('gen-store-assets palette', () => {
  it('reads the status palette from the product instead of restating it', () => {
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

  it('paints the reserved danger red only on the stop-all key, never a status', () => {
    // #e5484d is `stopFace`'s danger red (interrupt-all); the REAL stop-all key is red too, so the
    // mockup mirrors it. But it must never restate a project STATUS in that red (the old bug).
    for (const line of code.split('\n').filter((l) => l.includes('#e5484d'))) {
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

  it('renders a full XL board — exactly 8×4 = 32 cells (guards an off-by-one that misplaces the bottom row)', () => {
    // The mock board mirrors a real XL. A miscount silently shifts the bottom-row keys a column and
    // leaves a hole — invisible in tests until someone eyeballs the PNG. Count the cell tokens.
    // Strip every `//` comment (full-line AND trailing) from the block before counting, so a
    // commented-out cell drops the count instead of being tallied — which would hide the very
    // off-by-one this guards. (No cell literal contains `//`, so this can't eat real content.)
    const block = /const boardCells = \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? '';
    const bare = block.replace(/\/\/.*$/gm, '');
    const count = (re: RegExp) => bare.match(re)?.length ?? 0;
    const cells = count(/\bK\(/g) + count(/\bBLANK\b/g) + count(/\bLOGO_CELL\b/g) + count(/\bTELEGRAM\b/g);
    expect(cells).toBe(32);
  });
});
