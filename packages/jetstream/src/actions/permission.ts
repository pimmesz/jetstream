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
  /** The perm.id last PAINTED on the key face. A press answers THIS request, not whatever
   * is head at press time — so a double-tap or a timeout head-swap can't approve a request
   * the user never saw. */
  private shownId: string | undefined;

  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<PermissionSettings>): Promise<void> {
    const decision = ev.payload.settings.decision ?? 'allow';
    // Settle the request the face SHOWED. If it's no longer the head (answered/timed out),
    // settle() no-ops → alert, and the subscription repaint shows the current request.
    if (!permissions.settle(this.shownId, decision)) await ev.action.showAlert();
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
            // E: the pending command needs to be READABLE (`Bash: rm -rf dist/build`), so
            // give it a longer, smaller line instead of cutting it at ~14 chars.
            subMax: 24,
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
    // Set AFTER the paint lands, not before: a press answers the id actually ON the face. If we
    // set it up front, a press during the awaited paint could settle a request not yet shown;
    // keeping the previous id makes such a press fail settle() → alert, never a blind approve.
    this.shownId = pending?.id;
  }
}
