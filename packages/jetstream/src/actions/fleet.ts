import { readFileSync } from 'node:fs';
import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyAction, KeyDownEvent } from '@elgato/streamdeck';
import { colorFor, glyphFor, summarize, worstStatus } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { isListenerBound } from '../listener-status';
import { checkHooksPresent } from '../doctor';
import { defaultSettingsPath } from '../hooks-install';
import type { Face } from '../render';
import { keyFace } from '../render';

/** The fleet roll-up face from LIVE board state: worst-status colour + compact `Nw N! N✓` counts, or
 * a dark "add repos / idle · press?" invite. Shared by the standalone Fleet key and the slot `fleet`
 * kind so both paint identically. */
export function fleetFace(): Face {
  const byProject = board.byProject();
  const worst = worstStatus(byProject);
  if (worst === 'none') {
    // Dark board: an empty fleet is the common first-run cause; otherwise invite the press.
    const empty = board.projects().length === 0;
    return { color: empty ? '#b58900' : '#26262b', label: 'fleet', sub: empty ? 'add repos' : 'idle · press?' };
  }
  const { working, waiting, done } = summarize(byProject);
  // Compact enough for a 144px key: e.g. `3w 1! 2✓` (working / waiting / done).
  return { color: colorFor(worst, config.get().theme), glyph: glyphFor(worst), label: 'fleet', sub: `${working}w ${waiting}! ${done}✓` };
}

/** The likeliest reason the board shows no sessions, cheapest-signal first — the press-to-doctor
 * hint on a dark Fleet key. Shared by the standalone key and the slot `fleet` kind. */
export function darkReason(): string {
  if (!isListenerBound()) return 'hooks offline'; // the listener never bound → no event can arrive
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
    await ev.action.setImage(keyFace({ color: '#b58900', label: 'why dark?', sub: darkReason() }));
    setTimeout(() => void this.renderOne(ev.action), 2600);
  }

  async renderAll(): Promise<void> {
    for (const visible of this.actions) {
      if (visible.isKey()) await this.renderOne(visible);
    }
  }

  private async renderOne(a: KeyAction): Promise<void> {
    await a.setTitle('');
    await a.setImage(keyFace(fleetFace()));
  }
}
