import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { runClaude } from '@pimmesz/jetstream-claude';
import { config } from '../config';
import { keyFace } from '../render';

/** A preset headless launch: fire `claude -p` with this key's prompt in its project
 * dir. Spends the subscription (the API key is stripped by the claude core); note
 * headless runs draw the Agent-SDK allotment, NOT the 5h/7d gauge's pool. */
export type LaunchSettings = {
  name?: string;
  path?: string;
  prompt?: string;
  model?: string;
  permissionMode?: string;
  /** Comma-separated, e.g. `Read,Grep,Bash`. */
  allowedTools?: string;
}

@action({ UUID: 'gg.pim.jetstream.launch' })
export class LaunchKey extends SingletonAction<LaunchSettings> {
  private running = new Set<string>();

  override async onWillAppear(): Promise<void> {
    await this.renderAll();
  }

  override async onDidReceiveSettings(): Promise<void> {
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent<LaunchSettings>): Promise<void> {
    const { settings } = ev.payload;
    const id = ev.action.id;
    if (this.running.has(id)) return; // one run per key at a time
    if (!settings.prompt || !settings.path) {
      await ev.action.showAlert();
      return;
    }
    this.running.add(id);
    await ev.action.setTitle('');
    await ev.action.setImage(
      keyFace({ color: '#e5484d', label: this.label(settings), sub: 'running…' }),
    );
    try {
      // This key's own model wins; else the global Model-key override (empty = Claude default).
      const model = settings.model?.trim() || config.get().launchModel;
      const result = await runClaude(
        {
          prompt: settings.prompt,
          cwd: settings.path,
          ...(model ? { model } : {}),
          ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
          ...(settings.allowedTools
            ? { allowedTools: settings.allowedTools.split(',').map((t) => t.trim()).filter(Boolean) }
            : {}),
        },
        () => {
          /* per-event key updates are a nice-to-have; the result decides the face */
        },
      );
      const cost =
        result.costUsd !== undefined && result.costUsd > 0
          ? `$${result.costUsd.toFixed(result.costUsd < 1 ? 2 : 0)}`
          : '';
      await ev.action.setImage(
        keyFace({
          color: result.isError ? '#e5484d' : '#30a46c',
          label: this.label(settings),
          sub: result.isError ? 'failed' : cost ? `done · ${cost}` : 'done',
        }),
      );
      if (result.isError) await ev.action.showAlert();
      else await ev.action.showOk();
    } finally {
      this.running.delete(id);
    }
  }

  private label(settings: LaunchSettings): string {
    return settings.name?.trim() || 'launch';
  }

  async renderAll(): Promise<void> {
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      if (this.running.has(visible.id)) continue; // don't repaint an in-flight run
      const settings = await visible.getSettings();
      const configured = Boolean(settings.prompt && settings.path);
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: configured ? '#0091ff' : '#26262b',
          label: this.label(settings),
          // Name the missing field, not always "set prompt".
          ...(configured
            ? {}
            : { sub: settings.prompt && !settings.path ? 'set path' : 'set prompt' }),
        }),
      );
    }
  }
}
