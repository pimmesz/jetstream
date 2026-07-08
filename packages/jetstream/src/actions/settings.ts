import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { config, type JetstreamConfig } from '../config';
import { keyFace } from '../render';

/**
 * The settings key: shows the current theme; a press quick-toggles colour-blind
 * (high-contrast) mode. The full set (theme, long-press, refresh, escalate) is edited
 * in this key's property inspector, which reads/writes Stream Deck global settings.
 */
@action({ UUID: 'gg.pim.jetstream.settings' })
export class SettingsKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(): Promise<void> {
    const current = config.get();
    const next: JetstreamConfig = {
      ...current,
      theme: current.theme === 'default' ? 'highContrast' : 'default',
    };
    // Persist globally; the plugin's onDidReceiveGlobalSettings updates `config` and
    // repaints every key.
    await streamDeck.settings.setGlobalSettings(next);
  }

  async renderAll(): Promise<void> {
    const theme = config.get().theme;
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: '#3a3a3a',
          label: 'settings',
          sub: theme === 'highContrast' ? 'contrast: on' : 'contrast: off',
        }),
      );
    }
  }
}
