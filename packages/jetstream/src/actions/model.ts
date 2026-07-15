import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { config } from '../config';
import type { Face } from '../render';
import { keyFace } from '../render';

/** Cycle order for the global launch-model override. Plain strings (`claude -p` aliases —
 * never an enum); '' means "no override" (each Launch key's own model, else Claude's default). */
const MODELS = ['', 'opus', 'sonnet', 'haiku'] as const;

/** The model-toggle face: purple when an override is active, dim "default" otherwise. Pure. Shared by
 * the standalone Model key and the slot `model` kind. */
export function modelFace(model: string): Face {
  return { color: model ? '#7c5cff' : '#26262b', label: 'model', sub: model || 'default' };
}

/** Cycle the GLOBAL launch-model override to the next value and persist it (the round-trip through
 * global settings repaints every model face). Shared press behavior; benign, so no /slot gate. */
export async function cycleModel(): Promise<void> {
  const current = config.get();
  const i = MODELS.indexOf(current.launchModel as (typeof MODELS)[number]); // -1 → next = first
  await streamDeck.settings.setGlobalSettings({ ...current, launchModel: MODELS[(i + 1) % MODELS.length] ?? '' });
}

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
    await cycleModel();
  }

  async renderAll(): Promise<void> {
    const face = keyFace(modelFace(config.get().launchModel));
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }
}
