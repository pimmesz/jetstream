import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { colorFor, glyphFor, summarize, worstStatus } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { keyFace } from '../render';

/**
 * One always-visible roll-up key so the fleet is legible even when projects outnumber
 * keys: it shows the live counts and takes the colour of the WORST state present
 * (needsInput > working > done > idle), so "is anything waiting on me?" is answerable at
 * a glance. Read-only in v1.3 — press is an ack blip; paging the board is a later item.
 */
@action({ UUID: 'gg.pim.jetstream.fleet' })
export class FleetKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await ev.action.showOk();
  }

  async renderAll(): Promise<void> {
    const byProject = board.byProject();
    const worst = worstStatus(byProject);
    const { working, waiting, done } = summarize(byProject);
    const face =
      worst === 'none'
        ? keyFace({ color: '#26262b', label: 'fleet', sub: 'no sessions' })
        : keyFace({
            color: colorFor(worst, config.get().theme),
            glyph: glyphFor(worst),
            label: 'fleet',
            // Compact enough for a 144px key: e.g. `3w 1! 2✓` (working / waiting / done).
            sub: `${working}w ${waiting}! ${done}✓`,
          });
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }
}
