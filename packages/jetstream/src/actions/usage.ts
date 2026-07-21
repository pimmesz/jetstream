import { readFileSync } from 'node:fs';
import { action, SingletonAction } from '@elgato/streamdeck';
import { resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { usageStatuslineWired } from '../doctor';
import { defaultSettingsPath } from '../hooks-install';
import { formatNextReset, keyFace } from '../render';
import { paintKey } from '../paint';

/** Sub-label for a BLANK gauge: "install hook" when our statusline isn't wired — running claude
 * would change nothing, so saying "run claude" sends you the wrong way — else "run claude" (wired,
 * there's just no data yet). Reads settings only while the gauge is blank, never on the happy path. */
function blankSub(): string {
  let raw: string | undefined;
  try {
    raw = readFileSync(defaultSettingsPath(), 'utf8');
  } catch {
    raw = undefined;
  }
  return usageStatuslineWired(raw) ? 'run claude' : 'install hook';
}

/**
 * The usage gauge: 5h/7d used % + the sooner reset countdown, from the Jetstream usage cache
 * (the statusline hook). Refreshed by the plugin's timer; shows an explicit "install hook" state
 * when no data exists.
 */
@action({ UUID: 'gg.pim.jetstream.usage' })
export class UsageKey extends SingletonAction {
  private feed: UsageFeed | undefined;

  override onWillAppear(): void {
    void this.refresh();
  }

  async refresh(now = Date.now()): Promise<void> {
    // No Usage key on the deck → don't spend a subprocess resolving usage nobody will see
    // (mirrors the CI key, which also gates on a placed key first).
    if (![...this.actions].some((a) => a.isKey())) return;
    this.feed = await resolveUsage();
    const feed = this.feed;
    const face = feed.available
      ? keyFace({
          color: gaugeColor(feed),
          // Weekly is the headline → the big label. Show the 5-hour window on the line above when
          // both exist, and the sooner reset below. Both windows stay readable instead of 7d
          // hiding in a tiny sub-line.
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
      : keyFace({ color: '#26262b', label: 'no usage', sub: blankSub() });
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await paintKey(visible, face);
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
