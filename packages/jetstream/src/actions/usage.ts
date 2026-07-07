import { action, SingletonAction } from '@elgato/streamdeck';
import { resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { formatReset, keyFace } from '../render';

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
    this.feed = await resolveUsage();
    const feed = this.feed;
    const face = feed.available
      ? keyFace({
          color: gaugeColor(feed),
          ...(feed.model ? { top: feed.model } : {}),
          label: feed.fiveHour ? `5h ${Math.round(feed.fiveHour.usedPct)}%` : 'usage',
          sub: [
            feed.sevenDay ? `7d ${Math.round(feed.sevenDay.usedPct)}%` : '',
            formatReset(feed.fiveHour?.resetsAt, now),
          ]
            .filter(Boolean)
            .join(' · '),
        })
      : keyFace({ color: '#26262b', label: 'no usage', sub: 'install hook' });
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }
}

/** Green with headroom, amber when the tighter window passes 75%, red past 90%. */
function gaugeColor(feed: UsageFeed): string {
  const used = Math.max(feed.fiveHour?.usedPct ?? 0, feed.sevenDay?.usedPct ?? 0);
  if (used >= 90) return '#e5484d';
  if (used >= 75) return '#ffb224';
  return '#30a46c';
}
