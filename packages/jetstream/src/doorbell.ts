import { colorFor, glyphFor, shouldEscalate, type ProjectStatus } from '@pimmesz/jetstream-status';
import { board } from './state';
import { config } from './config';
import type { Face } from './render';

/**
 * The doorbell behind both the standalone Attention key and the `attention` slot kind: dim until a
 * project needs you, amber for a waiting turn and magenta for a turn that DIED (`failed`), with the
 * project's name and a +N when several are waiting. After `escalateAfterSec` unacknowledged it
 * FLASHES; a long press snoozes the flash (the face stays) so a blocked repo cannot flash forever.
 * One instance, so a snooze on either key quiets both.
 */

export interface DoorbellInput {
  waiting: Array<{ id: string; name: string }>;
  headStatus: ProjectStatus | undefined;
  snoozed: boolean;
  escalate: boolean;
  flashOn: boolean;
  theme: 'default' | 'highContrast';
}

/** The second line: how many more are waiting, else why the key is lit. */
function doorbellSub(i: DoorbellInput, isFailed: boolean): string {
  if (i.waiting.length > 1) return `+${i.waiting.length - 1} more`;
  if (i.snoozed) return 'snoozed';
  if (i.escalate) return isFailed ? 'still failed' : 'still waiting';
  return isFailed ? 'failed' : 'needs you';
}

/** The doorbell face for the current board. Pure. */
export function doorbellFace(i: DoorbellInput): Face {
  const first = i.waiting[0];
  if (!first) return { color: '#26262b', label: 'all clear' };
  // A waiting turn and a died turn need opposite actions (answer it vs re-run it), so they never
  // share the amber "needs you" face. A failed head must flash too, so it alternates magentas.
  const isFailed = i.headStatus === 'failed';
  const isPulsing = i.escalate && i.flashOn;
  const color = isFailed ? (isPulsing ? '#e93da0' : colorFor('failed', i.theme)) : isPulsing ? '#ffe08a' : '#ffb224';
  return {
    color,
    glyph: glyphFor(isFailed ? 'failed' : 'needsInput'),
    label: first.name,
    sub: doorbellSub(i, isFailed),
  };
}

/** What a doorbell key-up does, from how long it was held: a long hold SNOOZES the flash (only
 * when something is actually waiting), a short tap JUMPS to the neediest project, and either with
 * nothing waiting is a calm no-op. Pure. */
export function pressAction(held: number, longPressMs: number, hasWaiting: boolean): 'jump' | 'snooze' | 'none' {
  if (!hasWaiting) return 'none';
  return held >= longPressMs ? 'snooze' : 'jump';
}

/** The doorbell flashes only when something has waited past the escalation threshold AND the user
 * hasn't snoozed it; a snooze keeps the face but stops the pulsing. Pure. */
export function shouldFlash(oldestSince: number | undefined, now: number, escalateAfterMs: number, snoozedUntil: number): boolean {
  if (now < snoozedUntil) return false;
  return shouldEscalate(oldestSince, now, escalateAfterMs);
}

/** Snooze length: long enough to cover a call or a meeting. Fixed, not a setting, to keep it simple. */
const SNOOZE_MS = 60 * 60_000;

export class Doorbell {
  private flashOn = false;
  private flashTimer: ReturnType<typeof setInterval> | undefined;
  private snoozedUntil = 0;
  /** Repaints every doorbell key; set by the plugin so each flash frame reaches both key types. */
  onFrame: () => void = () => {};

  /** The face for now, starting or stopping the flash as the board requires. */
  face(now = Date.now()): Face {
    const waiting = board.attention();
    if (waiting.length === 0) this.snoozedUntil = 0; // all clear → the next wait alerts fresh
    const byProject = board.byProject();
    const sinces = waiting.map((p) => byProject[p.id]?.since).filter((s): s is number => s !== undefined);
    const oldest = sinces.length > 0 ? Math.min(...sinces) : undefined;
    const escalate = shouldFlash(oldest, now, config.get().escalateAfterSec * 1000, this.snoozedUntil);
    this.manageFlash(escalate);
    return doorbellFace({
      waiting,
      headStatus: waiting[0] ? byProject[waiting[0].id]?.status : undefined,
      snoozed: now < this.snoozedUntil,
      escalate,
      flashOn: this.flashOn,
      theme: config.get().theme,
    });
  }

  /** A key-up after `held` ms: snooze, or the repo path to jump to, or nothing. */
  press(held: number, now = Date.now()): { act: 'snooze' } | { act: 'jump'; path: string | undefined } | { act: 'none' } {
    const waiting = board.attention();
    const act = pressAction(held, config.get().longPressMs, waiting.length > 0);
    if (act === 'snooze') {
      this.snoozedUntil = now + SNOOZE_MS;
      this.onFrame();
      return { act };
    }
    if (act === 'jump') return { act, path: waiting[0]?.path };
    return { act };
  }

  private manageFlash(escalate: boolean): void {
    if (escalate && this.flashTimer === undefined) {
      this.flashTimer = setInterval(() => {
        this.flashOn = !this.flashOn;
        this.onFrame();
      }, 1000);
      // Never let the flash pin a disconnected plugin alive: on a restart the old process must exit
      // and free the hook port for its successor.
      this.flashTimer.unref?.();
    } else if (!escalate && this.flashTimer !== undefined) {
      clearInterval(this.flashTimer);
      this.flashTimer = undefined;
      this.flashOn = false;
    }
  }
}

export const doorbell = new Doorbell();
