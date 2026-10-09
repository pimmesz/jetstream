import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, WillAppearEvent } from '@elgato/streamdeck';
import { board } from '../state';
import { stopSessions } from '../stop-session';
import type { Face } from '../render';
import { keyFace } from '../render';
import { paintKey } from '../paint';
import { DANGER_RED } from '@pimmesz/jetstream-status';

/** The stop-all face: danger red with a live working-count when sessions run, dim "idle" otherwise.
 * Pure. Shared by the standalone InterruptAll key and the slot `stopall` kind. */
export function stopFace(working: number): Face {
  return {
    color: working > 0 ? DANGER_RED : '#26262b',
    label: 'stop all',
    sub: working > 0 ? `${working} working` : 'idle',
  };
}

/** How long the "stopping" confirmation owns its key before the live working-count returns. */
const NOTICE_MS = 2600;

/**
 * Panic key: one press stops the running turn of every Claude session across the whole fleet (the
 * sessions stay open): the fleet-wide sibling of the Project key's long-press interrupt. The face shows how many
 * projects are currently working so it reads as "N running · press to stop".
 */
@action({ UUID: 'gg.pim.jetstream.interruptall' })
export class InterruptAllKey extends SingletonAction {
  /** Key id → epoch ms until which "stopping" owns the key. The press lands while sessions work, when
   * board emits are densest, so a routine render would erase it before it can be read. */
  private noticeUntil = new Map<string, number>();

  override onWillAppear(ev: WillAppearEvent): void {
    // A reappearing key is blank, so a notice from before it left has nothing to protect: paint the
    // live face now. That notice's pending timer then finds no matching entry and only repaints.
    this.noticeUntil.delete(ev.action.id);
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const sent = stopSessions(board.allActiveSessions());
    // Repaint before the confirmation glyph, so the press visibly did something. "stopping", not
    // "idle": each session stops at its next tool call, which can be a while into a long reply.
    // Through paintKey, never setImage: a raw upload leaves the paint cache holding a stale face and
    // strands the key on its next genuine repaint. Swallow a failed repaint: a transient SDK hiccup
    // must not cost the user the confirmation for a press that DID stop the sessions.
    if (sent > 0) {
      const until = Date.now() + NOTICE_MS;
      this.noticeUntil.set(ev.action.id, until);
      await paintKey(ev.action, keyFace({ ...stopFace(sent), sub: 'stopping' })).catch(() => {});
      // Release by identity, not the clock: the timer can fire 1 ms short of `until`, and a newer press
      // keeps its own notice. Then repaint, since renders skipped meanwhile left "stopping" up.
      setTimeout(() => {
        if (this.noticeUntil.get(ev.action.id) === until) this.noticeUntil.delete(ev.action.id);
        void this.renderAll();
      }, NOTICE_MS);
    }
    await (sent > 0 ? ev.action.showOk() : ev.action.showAlert());
  }

  async renderAll(): Promise<void> {
    const working = Object.values(board.byProject()).filter((s) => s.status === 'working').length;
    const face = keyFace(stopFace(working));
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      if ((this.noticeUntil.get(visible.id) ?? 0) > Date.now()) continue;
      await visible.setTitle('');
      await paintKey(visible, face);
    }
  }
}
