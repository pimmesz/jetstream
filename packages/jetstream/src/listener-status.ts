/** Whether the plugin's hook listener actually bound its loopback port. plugin.ts sets it after the
 * (retrying) bind attempt; the Fleet key reads it to show a "hooks offline" face instead of a
 * misleading idle board when nothing can ever arrive. Module-level so the two don't import each other. */
let bound = false;

export function setListenerBound(value: boolean): void {
  bound = value;
}

export function isListenerBound(): boolean {
  return bound;
}
