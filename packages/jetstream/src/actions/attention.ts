import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { board } from '../state';
import { keyFace } from '../render';
import { openProject } from '../switchto';

/**
 * The doorbell: dim until ANY project needs input, then amber with the project's
 * name (and a +N when several are waiting). Press → jump to the first one.
 */
@action({ UUID: 'gg.pim.jetstream.attention' })
export class AttentionKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const [first] = board.attention();
    if (!first?.path || !openProject(first.path)) {
      await ev.action.showAlert();
    }
  }

  async renderAll(): Promise<void> {
    const waiting = board.attention();
    const first = waiting[0];
    const face = first
      ? keyFace({
          color: '#ffb224',
          label: first.name,
          sub: waiting.length > 1 ? `+${waiting.length - 1} more` : 'needs you',
        })
      : keyFace({ color: '#26262b', label: 'all clear' });
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }
}
