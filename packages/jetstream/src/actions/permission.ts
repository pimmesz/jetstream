import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import type { PermissionBehavior } from '@pimmesz/jetstream-status';
import { permissions } from '../permissions';
import { keyFace } from '../render';

/** Which decision this key issues. Place one Approve key and one Deny key; each acts
 * on the oldest pending Claude permission request. */
export type PermissionSettings = {
  decision?: PermissionBehavior;
};

@action({ UUID: 'gg.pim.jetstream.permission' })
export class PermissionKey extends SingletonAction<PermissionSettings> {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<PermissionSettings>): Promise<void> {
    const decision = ev.payload.settings.decision ?? 'allow';
    if (!permissions.settleHead(decision)) await ev.action.showAlert();
    // renderAll fires via the permissions subscription after settle.
  }

  async renderAll(): Promise<void> {
    const pending = permissions.head();
    const count = permissions.count();
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const settings = await visible.getSettings();
      const deny = settings.decision === 'deny';
      const face = pending
        ? keyFace({
            color: deny ? '#e5484d' : '#30a46c',
            label: deny ? 'DENY' : 'APPROVE',
            sub: count > 1 ? `${pending.summary} (+${count - 1})` : pending.summary,
          })
        : keyFace({
            color: '#26262b',
            label: deny ? 'deny' : 'approve',
            sub: 'no request',
          });
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }
}
