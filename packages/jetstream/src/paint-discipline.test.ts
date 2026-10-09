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
const SRC_DIR = new URL('./', import.meta.url);

/** Files allowed a direct setImage, each for a reason that is not a bypassed key face. */
const ALLOWED = new Set<string>([
  'actions/dial.ts', // Stream Deck + touchscreen: setFeedback, not a key image
  'paint.ts', // paintKey itself: the one cached upload every other paint goes through
]);

/** A raw upload, plain or optional-called (`a.setImage(x)`, `a.setImage?.(x)`). */
const RAW_SET_IMAGE = /\.setImage\??\.?\s*\(/;

/** Every non-test .ts under src, at any depth, as a path relative to src (`actions/slot.ts`). */
const sourceFiles = (): string[] =>
  readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );

describe('paint discipline', () => {
  it('no source file paints a key with a raw setImage: every paint goes through paintKey', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (ALLOWED.has(file)) continue;
      const src = readFileSync(new URL(file, SRC_DIR), 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        if (RAW_SET_IMAGE.test(line)) offenders.push(`${file}:${i + 1}`);
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
    const scanned = sourceFiles();
    expect(scanned.length).toBeGreaterThan(5);
    expect(scanned).toContain('actions/slot.ts'); // nested: the scan recurses
    expect(scanned).toContain('paint.ts'); // top level: not just actions/
    for (const raw of ['a.setImage(x)', 'a.setImage?.(x)', 'a.setImage (x)']) expect(RAW_SET_IMAGE.test(raw), raw).toBe(true);
    expect(RAW_SET_IMAGE.test('paintKey(a, x)')).toBe(false);
  });
});
