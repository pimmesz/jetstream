import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { deckForDeviceType, defaultProfileName, opsProfileName } from '../profile';
import { keyFace } from '../render';

/** Per-key setting: which page this nav key jumps to. */
export type NavSettings = {
  target?: 'board' | 'ops';
};

/**
 * Page navigation for the two-page bundled deck. A nav key on the Board profile targets
 * 'ops' (the controls page); one on the Ops profile targets 'board'. A press switches THIS
 * device (ev.action.device) to the matching per-device bundled profile — switchToProfile
 * only works for manifest-declared bundled profiles, which the Board/Ops pages are.
 */
@action({ UUID: 'gg.pim.jetstream.nav' })
export class NavKey extends SingletonAction<NavSettings> {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override onDidReceiveSettings(): void {
    void this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<NavSettings>): Promise<void> {
    const target = ev.payload.settings.target ?? 'ops';
    const device = ev.action.device;
    const deck = deckForDeviceType(device.type);
    if (!deck) {
      await ev.action.showAlert(); // no bundled profiles for this device (e.g. Stream Deck +)
      return;
    }
    const name = `profiles/${target === 'ops' ? opsProfileName(deck) : defaultProfileName(deck)}`;
    try {
      await streamDeck.profiles.switchToProfile(device.id, name);
    } catch {
      await ev.action.showAlert();
    }
  }

  async renderAll(): Promise<void> {
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const target = (await visible.getSettings()).target ?? 'ops';
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: '#3a3a3a',
          label: target === 'ops' ? 'ops →' : '← board',
          sub: target === 'ops' ? 'controls' : 'status',
        }),
      );
    }
  }
}
