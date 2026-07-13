import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, WillAppearEvent } from '@elgato/streamdeck';
import { deckForDeviceType, gridProfileName } from '../profile';
import { keyFace } from '../render';

/**
 * The "Grid toggle" key: flips the deck to the bundled coordinate-grid overlay so you can read off
 * key positions (a1…hN), then any key on the grid returns you (see CoordinateKey.onKeyDown). No
 * import needed — the Grid overlay is a plugin-bundled profile, and `switchToProfile` only reaches
 * bundled profiles. Place it on your board wherever you like.
 */
@action({ UUID: 'gg.pim.jetstream.grid' })
export class GridKey extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    void ev.action.setImage(keyFace({ color: '#14181f', label: 'grid', sub: 'a1…hN', glyph: '⊞' }));
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const device = ev.action.device;
    const deck = deckForDeviceType(device.type);
    if (!deck) {
      await ev.action.showAlert(); // no bundled grid for this device (e.g. Stream Deck +)
      return;
    }
    try {
      await streamDeck.profiles.switchToProfile(device.id, `profiles/${gridProfileName(deck)}`);
    } catch {
      await ev.action.showAlert();
    }
  }
}
