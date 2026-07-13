import { basename } from 'node:path';
import { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DidReceiveSettingsEvent,
  KeyAction,
  KeyDownEvent,
  WillAppearEvent,
} from '@elgato/streamdeck';
import type { Face } from '../render';
import { keyFace } from '../render';
import { config } from '../config';
import { execPlan, runPlan } from '../slot-exec';
import { parseSlotCommand } from '../slot-command';
import { imageMime, resolveSlotIcon } from '../slot-icon';

export type SlotKind = 'empty' | 'app' | 'url' | 'run';

/** A generic, plugin-owned board key. Empty slots self-label with their coordinate; a configured
 * slot is an app / URL / command shortcut. A type ALIAS (not interface) to satisfy the SDK's
 * JsonObject index-signature constraint — same as LaunchSettings / ProjectSettings. */
export type SlotSettings = {
  kind?: SlotKind; // absent → treated as 'empty'
  label?: string; // face-label override; else derived per kind
  app?: string; // kind 'app': absolute path, e.g. /Applications/Telegram.app
  url?: string; // kind 'url': an http(s) URL
  command?: string; // kind 'run': argv[0], resolved on PATH — NEVER a shell string
  args?: string[]; // kind 'run': argument vector, one argv slot each (no splitting)
  cwd?: string; // kind 'run': working directory
  icon?: string; // custom key image (a data: URI or an image file path); else an app slot shows the app's own icon
  color?: string; // face background override (#rrggbb); else the per-kind default
  sub?: string; // small second line override
  glyph?: string; // corner glyph / emoji override
};

const appName = (app: string | undefined): string =>
  app ? basename(app).replace(/\.app$/i, '') || 'open' : 'open';

const hostLabel = (url: string | undefined): string => {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 18);
  }
};

/** The per-kind default face, before any user overrides. */
function baseFace(s: SlotSettings): Face {
  switch (s.kind) {
    case 'app':
      return { color: '#7c5cff', label: appName(s.app), top: 'open' };
    case 'url':
      return { color: '#0091ff', label: 'open', sub: hostLabel(s.url), subMax: 20 };
    case 'run':
      return { color: '#0091ff', label: s.command ?? 'run', sub: 'run', glyph: '▸' };
    default:
      return { color: '#1c1c20', label: '' }; // empty → a blank dark key; coordinates live on the Grid toggle
  }
}

/** True when an `icon` value is an emoji/symbol (the key's MAIN visual) rather than an image
 * reference (a data URI or a file path). */
function isEmojiIcon(icon: string): boolean {
  return !icon.startsWith('data:') && !icon.includes('/') && !imageMime(icon);
}

/** The face a slot renders. User overrides — label, colour, subtitle, glyph — win over the per-kind
 * defaults, so "make a8 red", "put 🚀 on b2", and "add subtitle 'prod'" all just paint. An emoji set
 * as the `icon` becomes the big main visual (replacing an app logo). Pure. */
export function slotFace(s: SlotSettings): Face {
  const face: Face = {
    ...baseFace(s),
    ...(s.label ? { label: s.label } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(s.sub ? { sub: s.sub } : {}),
    ...(s.glyph ? { glyph: s.glyph } : {}),
  };
  const icon = s.icon?.trim();
  if (!icon || !isEmojiIcon(icon)) return face;
  // The emoji IS the main visual; drop a corner glyph that just duplicates it (models often set both).
  if (face.glyph === icon) delete face.glyph;
  return { ...face, emoji: icon };
}

/**
 * A self-labeling board slot. Empty keys show their a8-style coordinate; a configured slot opens an
 * app or URL, or runs a command, on press. Because the plugin owns every slot, `jetstream chat` can
 * retarget any coordinate LIVE (see `assign`) with no profile re-import.
 */
@action({ UUID: 'gg.pim.jetstream.slot' })
export class SlotKey extends SingletonAction<SlotSettings> {
  override async onWillAppear(ev: WillAppearEvent<SlotSettings>): Promise<void> {
    if (!ev.action.isKey()) return; // keypad-only; a dial has no board coordinate
    await this.render(ev.action, ev.payload.settings);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.render(ev.action, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    const settings = ev.payload.settings;
    // `run` executes an arbitrary command; keep it OPT-IN so a command planted via the unauthenticated
    // loopback /slot endpoint stays inert until the user enables run keys in Jetstream settings.
    if (settings.kind === 'run' && !config.get().allowRunKeys) {
      await ev.action.showAlert();
      return;
    }
    const plan = execPlan(settings);
    if (!plan) {
      await ev.action.showAlert(); // empty or invalid slot → harmless "nothing here" hint
      return;
    }
    if (runPlan(plan)) await ev.action.showOk();
    else await ev.action.showAlert();
  }

  /**
   * Retarget the slot at a coordinate from a `POST /slot` body — the live-edit path. The SDK offers
   * no key lookup, so we scan the visible instances of this action for the matching coordinate. It's
   * visible-only: a slot on another profile/page won't be found → 404 (the CLI surfaces "switch to
   * your board"). setSettings persists, so the change survives restart.
   */
  async assign(raw: unknown): Promise<{ status: number; body: string }> {
    const cmd = parseSlotCommand(raw);
    if (!cmd) return { status: 400, body: JSON.stringify({ error: 'bad slot command' }) };
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const c = visible.coordinates;
      if (!c || c.column !== cmd.column || c.row !== cmd.row) continue;
      await visible.setSettings(cmd.settings); // full replace
      await this.render(visible, cmd.settings);
      return { status: 200, body: JSON.stringify({ ok: true, coord: cmd.coord }) };
    }
    return { status: 404, body: JSON.stringify({ error: `no slot key at ${cmd.coord}` }) };
  }

  private async render(a: KeyAction, settings: SlotSettings): Promise<void> {
    await a.setTitle('');
    const face = slotFace(settings);
    // Paint the text/emoji face immediately (also the fallback when there's no image icon)…
    await a.setImage(keyFace(face));
    // …then resolve the image icon (app logo / custom image) and swap. A plain logo paints as the raw
    // image (cleanest); with a glyph override we composite so the corner badge isn't hidden.
    const icon = await resolveSlotIcon(settings);
    if (!icon) return;
    await a.setImage(face.glyph ? keyFace({ ...face, image: icon }) : icon);
  }
}
