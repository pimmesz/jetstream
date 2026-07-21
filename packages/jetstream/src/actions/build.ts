import { action, SingletonAction } from '@elgato/streamdeck';
import type { Face } from '../render';
import { keyFace } from '../render';
import { paintKey } from '../paint';

// esbuild replaces `__BUILD_ID__` with the compile-time stamp (scripts/build.mjs `define`).
// Under vitest there is no define, so `typeof` guards it and we fall back to 'dev'.
declare const __BUILD_ID__: string;
/** The build this bundle was compiled from (`MM-DD HH:MM:SS`), or 'dev' when run untooled. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** The build-stamp face: "MM-DD" on top, the time as the headline; 'dev' (no space) shows whole.
 * Pure — the stamp is a compile-time constant. Shared by the standalone Build key and the slot
 * `build` kind, so both paint identically. */
export function buildFace(): Face {
  const space = BUILD_ID.indexOf(' ');
  return {
    color: '#1f2933',
    top: space >= 0 ? BUILD_ID.slice(0, space) : 'build',
    label: space >= 0 ? BUILD_ID.slice(space + 1) : BUILD_ID,
    sub: 'build',
  };
}

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
    const face = keyFace(buildFace());
    for (const a of this.actions) {
      if (!a.isKey()) continue;
      await a.setTitle('');
      await paintKey(a, face);
    }
  }
}
