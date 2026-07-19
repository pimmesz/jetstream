/**
 * Pure long-press math shared by the press-driven actions (Project, Attention, Permission, the
 * Fleet dial). Each action records key-down time in a per-instance map; on key-up this reads AND
 * clears the entry (delete-on-read, so a stray second up-event can't reuse a stale start)
 * and returns how long the press was held. Never pressed → 0.
 */
export function heldMs(pressAt: Map<string, number>, id: string, now?: number): number {
  const started = pressAt.get(id);
  pressAt.delete(id);
  // Sample the clock AFTER the get/delete — matching the position of the inline code this
  // replaced — so the elapsed math is identical; `now` stays injectable for tests.
  return started === undefined ? 0 : (now ?? Date.now()) - started;
}
