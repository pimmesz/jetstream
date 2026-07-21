import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, KeyUpEvent } from '@elgato/streamdeck';
import type { PermissionBehavior } from '@pimmesz/jetstream-status';
import { permissions } from '../permissions';
import { config } from '../config';
import { heldMs } from '../press';
import { keyFace } from '../render';
import { paintKey } from '../paint';

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
  /** key-down time, so a long hold on APPROVE reads as an Always-Allow arm (measured down→up). */
  private pressAt = new Map<string, number>();
  /** The request id shown AT KEY-DOWN, captured per key. The action fires on key-up, and the head
   * can swap during a long hold (a timeout, or another key answering it) — so acting on the LIVE
   * `shownId` could settle/arm a request the user never pressed on. Acting on the captured id means
   * a swap fails the head-guard (→ alert) instead, so the user re-decides on the current request. */
  private pressedId = new Map<string, string | undefined>();

  override onWillAppear(): void {
    void this.renderAll();
  }

  override onKeyDown(ev: KeyDownEvent<PermissionSettings>): void {
    this.pressAt.set(ev.action.id, Date.now());
    this.pressedId.set(ev.action.id, this.shownId);
  }

  override async onKeyUp(ev: KeyUpEvent<PermissionSettings>): Promise<void> {
    const decision = ev.payload.settings.decision ?? 'allow';
    const longPress = heldMs(this.pressAt, ev.action.id) >= config.get().longPressMs;
    const targetId = this.pressedId.get(ev.action.id); // the request shown when the press STARTED
    this.pressedId.delete(ev.action.id);
    // Long-press on APPROVE = Always-Allow: settle 'allow' AND arm a session+tool auto-allow rule so
    // repeat-safe prompts stop needing a keypress. Deny is always one-shot — a long Deny just denies.
    const arming = decision === 'allow' && longPress;
    const ok = arming ? permissions.allowAlways(targetId) : permissions.settle(targetId, decision);
    if (!ok) await ev.action.showAlert();
    else if (arming) await ev.action.showOk(); // confirm the auto-allow rule was armed
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
            // Persistent reminder on the idle APPROVE key that auto-allow is active — so an armed
            // rule can never quietly keep approving without the user knowing it's on.
            sub: !deny && permissions.allowRuleCount() > 0 ? `auto-allow: ${permissions.allowRuleCount()}` : 'no request',
          });
      await visible.setTitle('');
      await paintKey(visible, face);
    }
    // Set AFTER the paint lands, not before: a press answers the id actually ON the face. If we
    // set it up front, a press during the awaited paint could settle a request not yet shown;
    // keeping the previous id makes such a press fail settle() → alert, never a blind approve.
    this.shownId = pending?.id;
  }
}
