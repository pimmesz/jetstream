import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DidReceiveSettingsEvent,
  KeyAction,
  KeyDownEvent,
  WillAppearEvent,
} from '@elgato/streamdeck';
import { deckForDeviceType, defaultProfileName, opsProfileName } from '../profile';
import { keyFace } from '../render';
import { paintKey } from '../paint';

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
  // Render from the event's OWN payload — never re-fetch with getSettings().
  //
  // `getSettings()` is a socket round-trip whose reply is the shared `didReceiveSettings` event,
  // so calling it from `onDidReceiveSettings` fed itself: settings arrive → render → fetch →
  // settings arrive → … an unbounded loop of socket traffic and setTitle writes for as long as the
  // key is visible. (The SDK only suppresses that echo under `useExperimentalMessageIdentifiers`,
  // which is hardcoded false.) A nav key ships on both bundled pages, so this ran on stock boards.
  // slot.ts documents and guards the same echo; nav.ts had both halves and no guard.
  override onWillAppear(ev: WillAppearEvent<NavSettings>): void {
    if (!ev.action.isKey()) return; // keypad-only; a dial has no nav face
    void this.renderOne(ev.action, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<NavSettings>): void {
    if (!ev.action.isKey()) return;
    void this.renderOne(ev.action, ev.payload.settings);
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

  private async renderOne(a: KeyAction, settings: NavSettings): Promise<void> {
    const target = settings.target ?? 'ops';
    await a.setTitle('');
    await paintKey(
      a,
      keyFace({
        color: '#3a3a3a',
        label: target === 'ops' ? 'ops →' : '← board',
        sub: target === 'ops' ? 'controls' : 'status',
      }),
    );
  }
}
