import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { config } from '../config';
import { keyFace } from '../render';

/** Cycle order for the global launch-model override. Plain strings (`claude -p` aliases —
 * never an enum); '' means "no override" (each Launch key's own model, else Claude's default). */
const MODELS = ['', 'opus', 'sonnet', 'haiku'] as const;

/**
 * A global model toggle: press to cycle the model the Launch keys fall back to when their
 * own `model` is unset. Persisted in Stream Deck global settings, so every Launch key picks
 * it up live (launch.ts reads `config.get().launchModel`).
 */
@action({ UUID: 'gg.pim.jetstream.model' })
export class ModelKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  override async onKeyDown(): Promise<void> {
    const current = config.get();
    const i = MODELS.indexOf(current.launchModel as (typeof MODELS)[number]); // -1 → next = first
    await streamDeck.settings.setGlobalSettings({
      ...current,
      launchModel: MODELS[(i + 1) % MODELS.length] ?? '',
    });
  }

  async renderAll(): Promise<void> {
    const model = config.get().launchModel;
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(
        keyFace({ color: model ? '#7c5cff' : '#26262b', label: 'model', sub: model || 'default' }),
      );
    }
  }
}
