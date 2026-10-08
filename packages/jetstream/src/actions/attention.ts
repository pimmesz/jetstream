import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, KeyUpEvent } from '@elgato/streamdeck';
import { doorbell } from '../doorbell';
import { heldMs } from '../press';
import { keyFace } from '../render';
import { paintKey } from '../paint';
import { openProjectFromKey } from '../switchto';

/**
 * The standalone doorbell key. Short press → jump to the neediest project; long press → snooze the
 * flash. The face and the snooze live in doorbell.ts, shared with the `attention` slot kind.
 */
@action({ UUID: 'gg.pim.jetstream.attention' })
export class AttentionKey extends SingletonAction {
  private pressAt = new Map<string, number>();

  override onWillAppear(): void {
    void this.renderAll();
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.pressAt.set(ev.action.id, Date.now()); // measured down→up so a long hold reads as a snooze
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const result = doorbell.press(heldMs(this.pressAt, ev.action.id));
    if (result.act === 'jump' && result.path && !(await openProjectFromKey(result.path))) await ev.action.showAlert();
    // 'none' → a calm no-op (nothing waiting), not an error shake.
  }

  async renderAll(now = Date.now()): Promise<void> {
    const face = keyFace(doorbell.face(now));
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await paintKey(visible, face);
    }
  }
}
