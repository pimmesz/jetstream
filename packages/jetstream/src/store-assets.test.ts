import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorFor, glyphFor, type ProjectStatus } from '@pimmesz/jetstream-status';

// The store/marketing generator paints mock Stream Deck keys that people judge the product by.
// It used to restate the status palette as its own literal table, which silently drifted: every
// shipped gallery painted `working` in #e5484d — the red the status package reserves for danger
// and forbids as a status (see index.test.ts) — and `idle` in #0091ff, which is `done` in the
// high-contrast theme. The generator now imports colorFor/glyphFor, so the drift cannot recur by
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
    for (const status of STATUSES) {
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

  it('never paints a mock key in the reserved danger red', () => {
    expect(code).not.toContain('#e5484d');
    for (const status of STATUSES) {
      expect(colorFor(status)).not.toBe('#e5484d');
      expect(colorFor(status, 'highContrast')).not.toBe('#e5484d');
    }
  });

  it('labels mock keys with the product glyphs, not lookalike characters', () => {
    for (const status of ['working', 'needsInput', 'done', 'idle'] as ProjectStatus[]) {
      expect(code).toContain(`glyphFor('${status}')`);
    }
    // '...' would render as three periods where the product shows a single '⋯'.
    expect(code).not.toMatch(/glyph: '\.\.\.'/);
    expect(glyphFor('working')).toBe('⋯');
  });
});
