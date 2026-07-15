import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyAction, KeyDownEvent, WillAppearEvent } from '@elgato/streamdeck';
import type { Face } from '../render';
import { keyFace } from '../render';
import { readInputVolume, writeInputVolume } from '../mic-control';

/** The mic-mute key face: red + MUTED when the input is at 0, dark when live; a dim "n/a" when the
 * OS won't report an input volume (non-macOS). Pure. */
export function micFace(muted: boolean, available: boolean): Face {
  if (!available) return { color: '#26262b', label: 'mic', sub: 'n/a' };
  return muted ? { color: '#e5484d', emoji: '🎙', label: 'MUTED' } : { color: '#1c1c20', emoji: '🎙', label: 'mic' };
}

/**
 * A hardware mic-mute toggle: one press sets the default input (mic) volume to 0 (mute) or restores
 * it. Deck-worthy because there is no physical control for the mic and you often want it hands-free.
 * The face shows the live/muted state (repainted on the board tick so an external mute still reflects).
 */
@action({ UUID: 'gg.pim.jetstream.micmute' })
export class MicMuteKey extends SingletonAction {
  /** Level to restore on unmute — captured at the moment of muting (default 75 if unknown). */
  private restoreLevel = 75;
  /** A press reads-then-writes the volume via two osascript calls; a second press landing between them
   * would read the pre-mute level again and both would write 0 (stuck muted). Drop presses while one
   * toggle is in flight — one press = one toggle. */
  private toggling = false;
  /** renderBoard() calls renderAll on every hook event; each render spawns osascript. Single-flight so
   * a burst of events can't pile up overlapping subprocesses — the next tick just repaints. */
  private refreshing = false;

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.render(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.toggling) return;
    this.toggling = true;
    try {
      const current = await readInputVolume();
      if (current === undefined) {
        await ev.action.showAlert(); // OS won't report/accept an input volume
        return;
      }
      if (current > 0) {
        this.restoreLevel = current;
        await writeInputVolume(0);
      } else {
        await writeInputVolume(this.restoreLevel || 75);
      }
      if (ev.action.isKey()) await this.render(ev.action);
    } finally {
      this.toggling = false;
    }
  }

  async renderAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const visible of this.actions) if (visible.isKey()) await this.render(visible);
    } finally {
      this.refreshing = false;
    }
  }

  private async render(a: KeyAction): Promise<void> {
    const level = await readInputVolume();
    await a.setTitle('');
    await a.setImage(keyFace(micFace(level === 0, level !== undefined)));
  }
}
