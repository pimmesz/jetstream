import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { glyphFor, shouldEscalate } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { keyFace } from '../render';
import { openProject } from '../switchto';

/**
 * The doorbell: dim until ANY project needs input, then amber with the project's
 * name (and a +N when several are waiting). After `escalateAfterSec` unacknowledged,
 * it FLASHES (pulses colour) so it can't be missed. Press → jump to the neediest.
 */
@action({ UUID: 'gg.pim.jetstream.attention' })
export class AttentionKey extends SingletonAction {
  private flashOn = false;
  private flashTimer: ReturnType<typeof setInterval> | undefined;

  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const [first] = board.attention();
    if (!first?.path) return; // nothing waiting → a calm no-op, not an error shake
    if (!openProject(first.path)) await ev.action.showAlert();
  }

  async renderAll(now = Date.now()): Promise<void> {
    const waiting = board.attention();
    const first = waiting[0];
    const byProject = board.byProject();
    const sinces = waiting
      .map((p) => byProject[p.id]?.since)
      .filter((s): s is number => s !== undefined);
    const oldest = sinces.length > 0 ? Math.min(...sinces) : undefined;
    const escalate = shouldEscalate(oldest, now, config.get().escalateAfterSec * 1000);
    this.manageFlash(escalate);

    const amber = escalate && this.flashOn ? '#ffe08a' : '#ffb224';
    const face = first
      ? keyFace({
          color: amber,
          glyph: glyphFor('needsInput'),
          label: first.name,
          sub:
            waiting.length > 1
              ? `+${waiting.length - 1} more`
              : escalate
                ? 'still waiting'
                : 'needs you',
        })
      : keyFace({ color: '#26262b', label: 'all clear' });

    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
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
