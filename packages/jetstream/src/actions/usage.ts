import { readFileSync } from 'node:fs';
import { action, SingletonAction, type KeyDownEvent } from '@elgato/streamdeck';
import { longWindowLabel, resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { usageStatuslineWired } from '../doctor';
import { defaultSettingsPath } from '../hooks-install';
import { formatCountdown, formatNextReset, keyFace, type Face } from '../render';
import { paintKey } from '../paint';
import { DANGER_RED } from '@pimmesz/jetstream-status';

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
  /** Bumped by every refresh, so a slower, older read cannot paint over a newer one. */
  private generation = 0;

  override onWillAppear(): void {
    void this.refresh();
  }

  /** A press re-reads now instead of waiting for the timer; the alert says there is still no usage
   * or the repaint failed, so a press always answers. */
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    let feed: UsageFeed | undefined;
    try {
      feed = await this.refresh();
    } catch {
      await ev.action.showAlert();
      return;
    }
    await (feed?.available ? ev.action.showOk() : ev.action.showAlert());
  }

  /** Returns the feed this call read, even when a newer refresh won the paint, so a press answers from its own read. */
  async refresh(now = Date.now()): Promise<UsageFeed | undefined> {
    // No Usage key on the deck → don't spend a subprocess resolving usage nobody will see
    // (mirrors the CI key, which also gates on a placed key first).
    if (![...this.actions].some((a) => a.isKey())) return undefined;
    const generation = ++this.generation;
    const feed = await resolveUsage();
    if (generation !== this.generation) return feed;
    const face = keyFace(usageFace(feed, now));
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await paintKey(visible, face);
    }
    return feed;
  }
}

export type UsageProvider = 'claude' | 'codex';

/**
 * The gauge face for one provider. Weekly is the headline (the big label); the 5-hour window sits on
 * the line above when both exist, and the sooner reset below. A Codex gauge names itself on top, so
 * two gauges side by side cannot be confused. Pure apart from the Claude blank state, which checks
 * whether the statusline hook is wired.
 */
export function usageFace(feed: UsageFeed | undefined, now: number, provider: UsageProvider = 'claude'): Face {
  if (!feed?.available) {
    return provider === 'codex'
      ? { color: '#26262b', label: 'no codex', sub: 'run codex' }
      : { color: '#26262b', label: 'no usage', sub: blankSub() };
  }
  const five = feed.fiveHour ? `5h ${Math.round(feed.fiveHour.usedPct)}%` : undefined;
  const top = provider === 'codex' ? (five && feed.sevenDay ? `codex ${five}` : 'codex') : feed.sevenDay ? five : undefined;
  return {
    color: gaugeColor(feed),
    ...(top ? { top } : {}),
    label: feed.sevenDay ? `${longWindowLabel(feed.sevenDay)} ${Math.round(feed.sevenDay.usedPct)}%` : (five ?? 'usage'),
    subMax: 18,
    sub: usageSub(feed, now),
  };
}

/** A reading older than this misses any use since then (claude.ai, Codex cloud, another machine). */
const STALE_READING_MS = 60 * 60_000;

/** Both gauges count used, never left, and say so. A stale reading shows its age instead of the reset. */
function usageSub(feed: UsageFeed, now: number): string {
  const age = feed.readAt === undefined ? 0 : now - feed.readAt;
  if (age > STALE_READING_MS) return `used·${formatCountdown(age)} old`;
  const reset = formatNextReset(feed.fiveHour?.resetsAt, feed.sevenDay?.resetsAt, now);
  return reset ? `used·${reset}` : 'used';
}

/** Green while under half the budget, amber from 50%, red once either window is close to full
 * (90%+). Driven by max(5h, 7d) — whichever window is nearest its limit colours the key, so a
 * tight 5-hour OR a tight 7-day window warns you. */
export function gaugeColor(feed: UsageFeed): string {
  const used = Math.max(feed.fiveHour?.usedPct ?? 0, feed.sevenDay?.usedPct ?? 0);
  if (used >= 90) return DANGER_RED;
  if (used >= 50) return '#ffb224';
  return '#30a46c';
}
