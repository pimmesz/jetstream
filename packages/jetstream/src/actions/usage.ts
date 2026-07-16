import { action, SingletonAction } from '@elgato/streamdeck';
import { resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { formatNextReset, keyFace } from '../render';

/**
 * The usage gauge: 5h/7d used % + the sooner reset countdown, from the Jetstream
 * usage cache (statusline hook) with afterburner as fallback. Refreshed by the
 * plugin's timer; shows an explicit "install hook" state when no data exists.
 */
@action({ UUID: 'gg.pim.jetstream.usage' })
export class UsageKey extends SingletonAction {
  private feed: UsageFeed | undefined;

  override onWillAppear(): void {
    void this.refresh();
  }

  async refresh(now = Date.now()): Promise<void> {
    // No Usage key on the deck → don't spend a subprocess resolving usage nobody will see
    // (mirrors the CI / heartbeat / review keys, which all gate on a placed key first).
    if (![...this.actions].some((a) => a.isKey())) return;
    this.feed = await resolveUsage();
    const feed = this.feed;
    const face = feed.available
      ? keyFace({
          color: gaugeColor(feed),
          // Weekly is the headline (afterburner's whole premise) → the big label. Show the
          // 5-hour window on the line above when both exist, and the sooner reset below. Both
          // windows stay readable instead of 7d hiding in a tiny sub-line.
          ...(feed.fiveHour && feed.sevenDay
            ? { top: `5h ${Math.round(feed.fiveHour.usedPct)}%` }
            : {}),
          label: feed.sevenDay
            ? `7d ${Math.round(feed.sevenDay.usedPct)}%`
            : feed.fiveHour
              ? `5h ${Math.round(feed.fiveHour.usedPct)}%`
              : 'usage',
          subMax: 18,
          sub: formatNextReset(feed.fiveHour?.resetsAt, feed.sevenDay?.resetsAt, now),
        })
      : keyFace({ color: '#26262b', label: 'no usage', sub: 'run claude' });
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }
}

/** Green while under half the budget, amber from 50%, red once either window is close to full
 * (90%+). Driven by max(5h, 7d) — whichever window is nearest its limit colours the key, so a
 * tight 5-hour OR a tight 7-day window warns you. */
export function gaugeColor(feed: UsageFeed): string {
  const used = Math.max(feed.fiveHour?.usedPct ?? 0, feed.sevenDay?.usedPct ?? 0);
  if (used >= 90) return '#e5484d';
  if (used >= 50) return '#ffb224';
  return '#30a46c';
}
