import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every key paint must go through `paintKey`.
 *
 * Two separate bugs came from breaking this, and neither was visible to a test or a code review of
 * the change that caused them:
 *
 * 1. FLICKER. A raw `setImage` is uploaded every time, and Stream Deck re-rasterises on each one.
 *    A board repaint fans out across every visible key on every hook event plus a 30s tick, so an
 *    uncached key visibly flashes all day and burns CPU while nothing is happening. slot.ts —
 *    which renders most of a chat-built board — had seven raw uploads and no cache at all.
 * 2. STRANDED FACES. Mixing a raw `setImage` with `paintKey` on the SAME key is worse than either:
 *    the raw upload leaves the cache remembering the previous face, so the next genuine repaint
 *    compares equal, is skipped, and the key stays stuck on a transient. That stranded the Fleet
 *    "why dark?" hint and the Project "release to interrupt" warning permanently.
 *
 * A static check is the right tool: both bugs are invisible at runtime in tests (no real deck) and
 * a reviewer reading a diff sees a perfectly ordinary `setImage` call.
 */
const ACTIONS_DIR = new URL('./actions/', import.meta.url);

/** Painting the deck's own OS-level surfaces, not a key face — nothing to cache. */
const ALLOWED = new Set<string>([
  'dial.ts', // Stream Deck + touchscreen: setFeedback, not a key image
]);

describe('paint discipline', () => {
  it('no action paints a key with a raw setImage — every paint goes through paintKey', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(ACTIONS_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || ALLOWED.has(file)) continue;
      const src = readFileSync(new URL(file, ACTIONS_DIR), 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        if (/\.setImage\s*\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(
      offenders,
      `Use paintKey(action, image) instead of action.setImage(image).\n` +
        `A raw upload flickers (it repaints on every board change) and, on a key that ALSO uses\n` +
        `paintKey, leaves the cache stale so the next real repaint is skipped and the key strands.`,
    ).toEqual([]);
  });

  it('the guard actually looks at files (it would catch a real offender)', () => {
    // A directory rename or a bad URL would make the loop above silently pass forever.
    const scanned = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(scanned.length).toBeGreaterThan(5);
    expect(scanned).toContain('slot.ts');
  });
});
