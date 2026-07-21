import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { board } from '../state';
import { interruptPids } from '../switchto';
import type { Face } from '../render';
import { keyFace } from '../render';
import { paintKey } from '../paint';

/** The stop-all face: danger red with a live working-count when sessions run, dim "idle" otherwise.
 * Pure. Shared by the standalone InterruptAll key and the slot `stopall` kind. */
export function stopFace(working: number): Face {
  return {
    color: working > 0 ? '#e5484d' : '#26262b',
    label: 'stop all',
    sub: working > 0 ? `${working} working` : 'idle',
  };
}

/**
 * Panic key: one press SIGINTs every running Claude session across the whole fleet — the
 * fleet-wide sibling of the Project key's long-press interrupt. The face shows how many
 * projects are currently working so it reads as "N running · press to stop".
 */
@action({ UUID: 'gg.pim.jetstream.interruptall' })
export class InterruptAllKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const sent = interruptPids(board.allPids());
    await (sent > 0 ? ev.action.showOk() : ev.action.showAlert());
  }

  async renderAll(): Promise<void> {
    const working = Object.values(board.byProject()).filter((s) => s.status === 'working').length;
    const face = keyFace(stopFace(working));
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await paintKey(visible, face);
    }
  }
}
