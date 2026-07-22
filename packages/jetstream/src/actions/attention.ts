import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, KeyUpEvent } from '@elgato/streamdeck';
import { colorFor, glyphFor, shouldEscalate } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { heldMs } from '../press';
import { keyFace } from '../render';
import { paintKey } from '../paint';
import { openProject } from '../switchto';

/**
 * The doorbell: dim until a project needs you — amber for a waiting turn, magenta for a turn
 * that DIED (`failed`) — with the project's name (and a +N when several are waiting). After `escalateAfterSec` unacknowledged,
 * it FLASHES (pulses colour) so it can't be missed. Short press → jump to the neediest;
 * LONG press → snooze the flash for a while (the face stays — amber for waiting, magenta for
 * failed — only the pulsing stops) so a genuinely-blocked repo can't flash at you forever (the 3am problem).
 */
@action({ UUID: 'gg.pim.jetstream.attention' })
export class AttentionKey extends SingletonAction {
  private flashOn = false;
  private flashTimer: ReturnType<typeof setInterval> | undefined;
  private pressAt = new Map<string, number>();
  /** Snooze silences the escalation flash for this long after a long-press. The face and
   * the jump-to-project press stay live — it only quiets the pulsing. Fixed (not a setting) to
   * keep it simple; long enough to cover a call or a meeting. */
  private static readonly SNOOZE_MS = 60 * 60_000;
  /** Epoch ms until which the flash is snoozed (0 = not snoozed). */
  private snoozedUntil = 0;

  override onWillAppear(): void {
    void this.renderAll();
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.pressAt.set(ev.action.id, Date.now()); // measured down→up so a long hold reads as a snooze
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const waiting = board.attention();
    const held = heldMs(this.pressAt, ev.action.id);
    const act = pressAction(held, config.get().longPressMs, waiting.length > 0);
    if (act === 'snooze') {
      this.snoozedUntil = Date.now() + AttentionKey.SNOOZE_MS;
      void this.renderAll();
    } else if (act === 'jump') {
      const path = waiting[0]?.path;
      if (path && !openProject(path)) await ev.action.showAlert();
    }
    // 'none' → a calm no-op (nothing waiting), not an error shake.
  }

  async renderAll(now = Date.now()): Promise<void> {
    const waiting = board.attention();
    const first = waiting[0];
    if (waiting.length === 0) this.snoozedUntil = 0; // all clear → drop the snooze so the next wait alerts fresh
    const byProject = board.byProject();
    const sinces = waiting
      .map((p) => byProject[p.id]?.since)
      .filter((s): s is number => s !== undefined);
    const oldest = sinces.length > 0 ? Math.min(...sinces) : undefined;
    const snoozed = now < this.snoozedUntil;
    const escalate = shouldFlash(oldest, now, config.get().escalateAfterSec * 1000, this.snoozedUntil);
    this.manageFlash(escalate);

    // The doorbell rings for two different things now: a turn WAITING on you, and a turn that DIED.
    // They need opposite actions (answer it vs. re-run it), so the key must not paint both amber
    // "needs you" — read the head project's real status and dress the key to match.
    const headStatus = first ? byProject[first.id]?.status : undefined;
    const isFailed = headStatus === 'failed';
    const amber = escalate && this.flashOn ? '#ffe08a' : '#ffb224';
    const face = first
      ? keyFace({
          // A failed head must ESCALATE too. Taking the constant `failed` colour meant `flashOn`
          // toggled nothing: every escalated frame was byte-identical, paintKey discarded it, and
          // the 1s flash timer ran forever painting nothing. That kills escalation entirely for
          // anyone running with permissions bypassed, for whom 'failed' IS the doorbell.
          color: isFailed
            ? escalate && this.flashOn
              ? '#e93da0' // a lighter magenta — the same alternation the amber pair uses
              : colorFor('failed', config.get().theme)
            : amber,
          glyph: glyphFor(isFailed ? 'failed' : 'needsInput'),
          label: first.name,
          sub:
            waiting.length > 1
              ? `+${waiting.length - 1} more`
              : snoozed
                ? 'snoozed'
                : escalate
                  ? isFailed
                    ? 'still failed'
                    : 'still waiting'
                  : isFailed
                    ? 'failed'
                    : 'needs you',
        })
      : keyFace({ color: '#26262b', label: 'all clear' });

    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await paintKey(visible, face);
    }
  }

  private manageFlash(escalate: boolean): void {
    if (escalate && this.flashTimer === undefined) {
      this.flashTimer = setInterval(() => {
        this.flashOn = !this.flashOn;
        void this.renderAll();
      }, 1000);
      // Never let the doorbell flash pin a disconnected plugin instance alive: when Stream Deck
      // restarts the plugin, the old process must drain and exit so it frees the hook port for
      // its successor (the SDK websocket keeps a live instance running regardless).
      this.flashTimer.unref?.();
    } else if (!escalate && this.flashTimer !== undefined) {
      clearInterval(this.flashTimer);
      this.flashTimer = undefined;
      this.flashOn = false;
    }
  }
}

/** What a doorbell key-up does, from how long it was held: a long hold SNOOZES the flash (only
 * when something is actually waiting), a short tap JUMPS to the neediest project, and either with
 * nothing waiting is a calm no-op. Pure. */
export function pressAction(
  held: number,
  longPressMs: number,
  hasWaiting: boolean,
): 'jump' | 'snooze' | 'none' {
  if (!hasWaiting) return 'none';
  return held >= longPressMs ? 'snooze' : 'jump';
}

/** The doorbell flashes only when something has waited past the escalation threshold AND the user
 * hasn't snoozed it — a snooze keeps the face but stops the pulsing. Pure. */
export function shouldFlash(
  oldestSince: number | undefined,
  now: number,
  escalateAfterMs: number,
  snoozedUntil: number,
): boolean {
  if (now < snoozedUntil) return false;
  return shouldEscalate(oldestSince, now, escalateAfterMs);
}
