import { basename } from 'node:path';
import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, KeyUpEvent, WillDisappearEvent } from '@elgato/streamdeck';
import { matchProject, type PermissionBehavior } from '@pimmesz/jetstream-status';
import { FACE_SUMMARY_MAX, isSummaryCut, permissions } from '../permissions';
import { heldMs } from '../press';
import { keyFace } from '../render';
import { paintKey } from '../paint';
import { board } from '../state';
import { DANGER_RED } from '@pimmesz/jetstream-status';

/** Which decision this key issues. Place one Approve key and one Deny key; each acts
 * on the oldest pending Claude permission request. */
export type PermissionSettings = {
  decision?: PermissionBehavior;
};

/** Holding APPROVE this long arms Always-Allow. Fixed, not the tunable longPressMs (as low as 200 ms and
 * shared with the doorbell snooze), so a grant that outlives the prompt always takes a deliberate hold. */
export const ARM_HOLD_MS = 1500;

/** The configured project a prompt came from, else its folder name: a press answers the oldest
 * request across every session, so the face says whose it is. */
function projectName(cwd: string): string {
  const projects = board.projects();
  const id = matchProject(cwd, projects);
  return projects.find((p) => p.id === id)?.name ?? basename(cwd);
}

@action({ UUID: 'gg.pim.jetstream.permission' })
export class PermissionKey extends SingletonAction<PermissionSettings> {
  /** The perm.id last PAINTED on each key's face, by action id. A press answers THIS request, not whatever
   * is head at press time, so a double-tap or a timeout head-swap can't approve a request the user never
   * saw. Per key, because a held APPROVE keeps its old face while the other keys repaint. */
  private shownIds = new Map<string, string | undefined>();
  /** key-down time, so a long hold on APPROVE reads as an Always-Allow arm (measured down→up). */
  private pressAt = new Map<string, number>();
  /** The request id shown AT KEY-DOWN, captured per key. The action fires on key-up, and the head
   * can swap during a long hold (a timeout, or another key answering it) — so acting on the LIVE
   * `shownIds` entry could settle/arm a request the user never pressed on. Acting on the captured id means
   * a swap fails the head-guard (→ alert) instead, so the user re-decides on the current request. */
  private pressedId = new Map<string, string | undefined>();
  /** The arm-warning timer of a held APPROVE key, from key-down until key-up or the key leaving the deck. */
  private holdWarn = new Map<string, ReturnType<typeof setTimeout>>();

  override onWillAppear(): void {
    void this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent<PermissionSettings>): void {
    // No key-up follows a key that left mid-hold, so its warning must never paint; it repaints on return.
    this.clearHoldWarn(ev.action.id);
    this.shownIds.delete(ev.action.id);
  }

  override onKeyDown(ev: KeyDownEvent<PermissionSettings>): void {
    this.pressAt.set(ev.action.id, Date.now());
    const targetId = this.shownIds.get(ev.action.id);
    this.pressedId.set(ev.action.id, targetId);
    // Deny is always one-shot, so only an APPROVE hold on a shown request can arm.
    if ((ev.payload.settings.decision ?? 'allow') !== 'allow' || targetId === undefined) return;
    this.holdWarn.set(
      ev.action.id,
      setTimeout(() => {
        const pending = permissions.head();
        // The request left during the hold, so the release alerts instead: no warning for it.
        if (pending?.id !== targetId) return;
        // Past the threshold, say what releasing does: arm an auto-allow, or why a compound command cannot.
        const armable = permissions.canArm(targetId);
        void paintKey(
          ev.action,
          keyFace({
            color: armable ? DANGER_RED : '#30a46c',
            // Split over two lines so a long tool name (NotebookEdit) is never cut off.
            top: armable ? 'auto-allow' : projectName(pending.cwd),
            label: armable ? 'ALWAYS' : 'APPROVE',
            subMax: FACE_SUMMARY_MAX,
            sub: armable ? `${pending.toolName}?` : 'chained: tap only',
          }),
        );
      }, ARM_HOLD_MS),
    );
  }

  override async onKeyUp(ev: KeyUpEvent<PermissionSettings>): Promise<void> {
    const decision = ev.payload.settings.decision ?? 'allow';
    const warned = this.clearHoldWarn(ev.action.id);
    const longPress = heldMs(this.pressAt, ev.action.id) >= ARM_HOLD_MS;
    const targetId = this.pressedId.get(ev.action.id); // the request shown when the press STARTED
    this.pressedId.delete(ev.action.id);
    // A long hold on APPROVE = Always-Allow: settle 'allow' AND arm an auto-allow rule (permissions.ts) so
    // repeat-safe prompts stop needing a keypress. Deny is always one-shot: a long Deny just denies.
    const arming = decision === 'allow' && longPress;
    const ok = arming ? permissions.allowAlways(targetId) : permissions.settle(targetId, decision);
    if (!ok) await ev.action.showAlert();
    else if (arming) await ev.action.showOk(); // confirm the auto-allow rule was armed
    if (warned) void this.renderAll(); // repaint over the arm warning
  }

  /** Clear a key's pending arm-warning timer; returns whether one was set. */
  private clearHoldWarn(actionId: string): boolean {
    const timer = this.holdWarn.get(actionId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.holdWarn.delete(actionId);
    return true;
  }

  async renderAll(): Promise<void> {
    const pending = permissions.head();
    const count = permissions.count();
    const project = pending ? projectName(pending.cwd) : '';
    // The queue count leads the top line, so the summary keeps the whole FACE_SUMMARY_MAX that
    // the `*` mark and the compound-command check in permissions.ts both assume.
    const top = count > 1 ? `(+${count - 1}) ${project}` : project;
    // A corner `*` says the command runs past the face: read it in Claude before approving.
    const isCut = pending !== undefined && isSummaryCut(pending.summary);
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      // A held APPROVE key keeps its face, warning and id until key-up repaints it.
      if (this.holdWarn.has(visible.id)) continue;
      const settings = await visible.getSettings();
      const deny = settings.decision === 'deny';
      const face = pending
        ? keyFace({
            color: deny ? DANGER_RED : '#30a46c',
            label: deny ? 'DENY' : 'APPROVE',
            top,
            ...(isCut ? { glyph: '*' } : {}),
            // E: the pending command needs to be READABLE (`Bash: rm -rf dist/build`), so
            // give it a longer, smaller line instead of cutting it at ~14 chars.
            subMax: FACE_SUMMARY_MAX,
            sub: pending.summary,
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
      // Set AFTER the paint lands, not before: a press answers the id actually ON the face. If we
      // set it up front, a press during the awaited paint could settle a request not yet shown;
      // keeping the previous id makes such a press fail settle() → alert, never a blind approve.
      this.shownIds.set(visible.id, pending?.id);
    }
  }
}
