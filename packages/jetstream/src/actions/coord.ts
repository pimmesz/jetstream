import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, WillAppearEvent } from '@elgato/streamdeck';
import { keyFace } from '../render';

/** The chessboard-style label for a key at (column,row), both 0-indexed: row = letter (a = top),
 * column = number (1 = left). So the top-right key of an XL (col 7, row 0) is "a8". Pure. */
export function coordLabel(column: number, row: number): string {
  return `${String.fromCharCode(97 + row)}${column + 1}`;
}

/**
 * A grid-reference key: renders its OWN "a8"-style coordinate (the SDK hands each key its
 * {column,row} on appear). The bundled Grid overlay places one on every slot, so you can read the
 * board's coordinates off the physical deck. The grid is throwaway — pressing ANY coordinate key
 * returns to your previous profile (your board), so it never gets in the way.
 */
@action({ UUID: 'gg.pim.jetstream.coord' })
export class CoordinateKey extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return; // keypad-only; a dial has no board coordinate
    const c = ev.action.coordinates;
    const label = c ? coordLabel(c.column, c.row) : '·';
    void ev.action.setImage(keyFace({ color: '#14181f', label, sub: 'tap→back' }));
  }

  /** Any press leaves the grid: switchToProfile with no name reactivates the previous profile. */
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await streamDeck.profiles.switchToProfile(ev.action.device.id);
  }
}
