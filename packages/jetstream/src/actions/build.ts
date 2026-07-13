import { action, SingletonAction } from '@elgato/streamdeck';
import { keyFace } from '../render';

// esbuild replaces `__BUILD_ID__` with the compile-time stamp (scripts/build.mjs `define`).
// Under vitest there is no define, so `typeof` guards it and we fall back to 'dev'.
declare const __BUILD_ID__: string;
/** The build this bundle was compiled from (`MM-DD HH:MM:SS`), or 'dev' when run untooled. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/**
 * A tiny "which build am I running?" key: renders the compile-time build stamp so you can
 * confirm the plugin loaded on the deck is the build you just made (the CLI prints the same
 * `build id:` line). Static — the stamp can't change without a rebuild — so it paints once.
 * Place it wherever you like, e.g. the top-right key.
 */
@action({ UUID: 'gg.pim.jetstream.build' })
export class BuildKey extends SingletonAction {
  override onWillAppear(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    // "MM-DD HH:MM:SS" → date on top, time as the headline; 'dev' has no space, so show it whole.
    const space = BUILD_ID.indexOf(' ');
    const top = space >= 0 ? BUILD_ID.slice(0, space) : 'build';
    const label = space >= 0 ? BUILD_ID.slice(space + 1) : BUILD_ID;
    const face = keyFace({ color: '#1f2933', top, label, sub: 'build' });
    for (const a of this.actions) {
      if (!a.isKey()) continue;
      await a.setTitle('');
      await a.setImage(face);
    }
  }
}
