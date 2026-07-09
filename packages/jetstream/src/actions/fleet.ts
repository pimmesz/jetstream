import { readFileSync } from 'node:fs';
import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyAction, KeyDownEvent } from '@elgato/streamdeck';
import { colorFor, glyphFor, summarize, worstStatus } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { checkHooksPresent } from '../doctor';
import { defaultSettingsPath } from '../hooks-install';
import { keyFace } from '../render';

/**
 * One always-visible roll-up key so the fleet is legible even when projects outnumber
 * keys: it shows the live counts and takes the colour of the WORST state present
 * (needsInput > working > done > idle), so "is anything waiting on me?" is answerable at
 * a glance. When the board is DARK (no live sessions) it becomes a self-diagnosis: it names
 * the likely reason (empty fleet / hooks not wired) and a press explains it on the face.
 */
@action({ UUID: 'gg.pim.jetstream.fleet' })
export class FleetKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    // Board lit → a simple ack blip. Board dark → press-to-doctor: paint the top reason for a
    // moment, then revert. The reason (add repos / wire hooks) is exactly what the in-app
    // checklist would fix, but on the key itself so a dark board isn't a dead end.
    if (worstStatus(board.byProject()) !== 'none') {
      await ev.action.showOk();
      return;
    }
    await ev.action.setImage(
      keyFace({ color: '#b58900', label: 'why dark?', sub: this.darkReason() }),
    );
    setTimeout(() => void this.renderOne(ev.action), 2600);
  }

  /** The likeliest reason the board shows no sessions, cheapest-signal first. */
  private darkReason(): string {
    if (board.projects().length === 0) return 'add repos';
    let raw: string | undefined;
    try {
      raw = readFileSync(defaultSettingsPath(), 'utf8');
    } catch {
      raw = undefined;
    }
    if (checkHooksPresent(raw).status === 'warn') return 'wire hooks';
    return 'all idle';
  }

  async renderAll(): Promise<void> {
    for (const visible of this.actions) {
      if (visible.isKey()) await this.renderOne(visible);
    }
  }

  private async renderOne(a: KeyAction): Promise<void> {
    const byProject = board.byProject();
    const worst = worstStatus(byProject);
    const { working, waiting, done } = summarize(byProject);
    let face: string;
    if (worst === 'none') {
      // Dark board: an empty fleet is the common first-run cause; otherwise invite the press.
      const empty = board.projects().length === 0;
      face = keyFace({
        color: empty ? '#b58900' : '#26262b',
        label: 'fleet',
        sub: empty ? 'add repos' : 'idle · press?',
      });
    } else {
      face = keyFace({
        color: colorFor(worst, config.get().theme),
        glyph: glyphFor(worst),
        label: 'fleet',
        // Compact enough for a 144px key: e.g. `3w 1! 2✓` (working / waiting / done).
        sub: `${working}w ${waiting}! ${done}✓`,
      });
    }
    await a.setTitle('');
    await a.setImage(face);
  }
}
