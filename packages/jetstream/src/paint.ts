/**
 * Skip a `setImage` whose image is byte-identical to what the key already shows.
 *
 * Every `renderAll` repaints every visible key, and the board re-renders on each state change plus
 * a 30s elapsed tick — so the large majority of uploads push a face the deck is already displaying.
 * Stream Deck re-rasterises on every `setImage`, which is the visible flicker (and the reason an
 * idle plugin accumulates hours of CPU). `keyFace()` is pure, so comparing the rendered string is a
 * sound change detector.
 *
 * Invalidation is the sharp edge. A key that disappears and re-appears — profile switch, page nav,
 * device reconnect — comes back BLANK, so a stale cache entry would match the face we want and skip
 * the very paint that fills it. Actions therefore call `forgetPainted()` from `onWillAppear` (and
 * `onWillDisappear` where they already implement it), which is why the cache is keyed by the
 * Stream Deck action id rather than by coordinate.
 */
const painted = new Map<string, string>();

/** The tail of each key's paint chain. Paints for one key run STRICTLY one after another, because
 * comparing against the cache while an upload is still in flight reads a face that is already
 * out of date: a transient (the interrupt warning) could be mid-upload while the revert compares
 * equal to the pre-transient face, skips, and leaves the warning as the final thing on the key.
 * Serializing makes every comparison see the face that actually landed. One entry per key, same
 * lifetime as `painted`. */
const chain = new Map<string, Promise<void>>();

/** A visible key, narrowed to what painting needs (keeps this testable without the SDK). */
export interface Paintable {
  id: string;
  setImage: (image: string) => Promise<void>;
}

/** Paint `image` only if it differs from the last one that successfully landed on this key. */
export function paintKey(action: Paintable, image: string): Promise<void> {
  const next = (chain.get(action.id) ?? Promise.resolve()).then(async () => {
    if (painted.get(action.id) === image) return;
    // Record only AFTER the paint lands: a rejected setImage (disconnected deck) must not be
    // remembered as displayed, or the key would stay stale until its face happens to change.
    await action.setImage(image);
    painted.set(action.id, image);
  });
  // The chain must survive a failed paint — swallow it for the NEXT link only, while the caller
  // still sees the rejection.
  chain.set(
    action.id,
    next.catch(() => {}),
  );
  return next;
}

/** Drop a key's remembered face. Call whenever the deck may have cleared it.
 *
 * Deliberately does NOT drop the chain: a paint may be in flight, and detaching the chain would
 * let the next paint run CONCURRENTLY with it — so whichever settles last wins and the key can
 * end up on the older face. Only the remembered face is forgotten, which is all this needs to do;
 * the chain is one small entry per key and is reclaimed by forgetAllPainted. */
export function forgetPainted(id: string): void {
  painted.delete(id);
}

/** Test seam / profile-switch reset: forget every key. */
export function forgetAllPainted(): void {
  painted.clear();
  chain.clear();
}
