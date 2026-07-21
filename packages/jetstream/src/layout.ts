import { normalizeColor } from './slot-color';
import { isHttpUrl } from './slot-command';
import type { DeckModel } from './profile';

/**
 * The chat layout designer's whitelist: the key TYPES the model may place, and how each turns
 * the model's fields into a profile action (UUID + Name + Settings). Deliberately a closed set —
 * the model can only place keys we understand, and each settings-builder validates its own input,
 * mirroring chat-setup's `extractSettings` "the model can't smuggle in a bad entry" contract.
 */
export interface KeyType {
  /** The Elgato action UUID placed in the generated profile (Jetstream or built-in). */
  uuid: string;
  /** The profile action's display Name. */
  name: string;
  /** Build the action Settings from the model-supplied fields, or return an error. Omitted for a
   * no-config key (Settings become null). */
  build?: (fields: Record<string, unknown>) => { settings: Record<string, unknown> } | { error: string };
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** Cosmetic overrides any slot key accepts: a custom label, an icon image, a background colour
 * (name or hex), a subtitle line, and a corner emoji. Shared by every slot builder. */
const slotCosmetics = (f: Record<string, unknown>): Record<string, unknown> => {
  const color = str(f.color) ? normalizeColor(str(f.color)!) : undefined;
  return {
    ...(str(f.label) ? { label: str(f.label) } : {}),
    ...(str(f.icon) ? { icon: str(f.icon) } : {}),
    ...(color ? { color } : {}),
    ...(str(f.sub) ? { sub: str(f.sub) } : {}),
    ...(str(f.glyph) ? { glyph: str(f.glyph) } : {}),
  };
};

/** No-config Jetstream keys (any placeable action with no per-key Settings). */
const NO_SETTINGS: Record<string, string> = {
  fleet: 'gg.pim.jetstream.fleet',
  attention: 'gg.pim.jetstream.attention',
  usage: 'gg.pim.jetstream.usage',
  settings: 'gg.pim.jetstream.settings',
  build: 'gg.pim.jetstream.build',
  'stop-all': 'gg.pim.jetstream.interruptall',
  micmute: 'gg.pim.jetstream.micmute',
  // Volume keys are slot-kind ONLY (no standalone action); the uuid here is a placeholder for the
  // prompt-name derivation and is overridden by the slot-kind KEY_TYPES entries below.
  volup: 'gg.pim.jetstream.slot',
  voldown: 'gg.pim.jetstream.slot',
  volmute: 'gg.pim.jetstream.slot',
  chat: 'gg.pim.jetstream.slot',
};

/** The no-settings placeable type names, in prompt order. Exported so the chat prompt's key
 * catalogue derives this tail instead of hand-listing it twice (a new no-settings key auto-appears
 * in the prompt); the KEY_TYPES ↔ SETUP_SYSTEM drift test guards the rest. */
export const NO_SETTINGS_TYPE_NAMES: readonly string[] = Object.keys(NO_SETTINGS);

const NO_SETTINGS_NAMES: Record<string, string> = {
  fleet: 'Fleet roll-up',
  attention: 'Attention',
  usage: 'Usage gauge',
  settings: 'Jetstream settings',
  build: 'Build version',
  'stop-all': 'Stop all',
  micmute: 'Mic mute',
  volup: 'Volume up',
  voldown: 'Volume down',
  volmute: 'Mute output',
  chat: 'Build by chat',
};

export const KEY_TYPES: Record<string, KeyType> = {
  // ── Slot shortcuts (plugin-owned, so chat can retarget them LIVE) ──
  // open-app / open-url place a gg.pim.jetstream.slot rather than a native Elgato key: the plugin
  // draws + handles them, which is what lets a later "move it / change it" apply without a re-import.
  'open-app': {
    uuid: 'gg.pim.jetstream.slot',
    name: 'App',
    build: (f) => {
      const app = str(f.app) ?? str(f.path);
      if (!app) return { error: 'open-app needs "app" (e.g. /Applications/Telegram.app)' };
      return { settings: { kind: 'app', app, ...slotCosmetics(f) } };
    },
  },
  'open-url': {
    uuid: 'gg.pim.jetstream.slot',
    name: 'URL',
    build: (f) => {
      const url = str(f.url) ?? str(f.path);
      if (!url) return { error: 'open-url needs "url"' };
      if (!isHttpUrl(url)) return { error: 'open-url needs an http(s) URL' };
      return { settings: { kind: 'url', url, ...slotCosmetics(f) } };
    },
  },
  run: {
    uuid: 'gg.pim.jetstream.slot',
    name: 'Run',
    build: (f) => {
      const command = str(f.command);
      if (!command) return { error: 'run needs "command"' };
      const args = Array.isArray(f.args) ? f.args.filter((a): a is string => typeof a === 'string') : undefined;
      return {
        settings: {
          kind: 'run',
          command,
          ...(args && args.length ? { args } : {}),
          ...(str(f.cwd) ? { cwd: str(f.cwd) } : {}),
          ...slotCosmetics(f),
        },
      };
    },
  },
  slot: { uuid: 'gg.pim.jetstream.slot', name: 'Empty slot', build: (f) => ({ settings: { kind: 'empty', ...slotCosmetics(f) } }) },
  // ── Built-in Elgato keys ──
  text: {
    uuid: 'com.elgato.streamdeck.system.text',
    name: 'Text',
    build: (f) => {
      const t = str(f.text);
      if (t === undefined) return { error: 'text needs "text"' };
      return { settings: { isSendingEnter: false, pastedText: t } };
    },
  },
  // ── Jetstream keys with settings ──
  // `project` is FOLDED into the plugin-owned slot (uuid slot, kind 'project') so a repo add/move
  // applies LIVE (POST /slot) with no profile re-import — same as build/stop-all/model/fleet below.
  // The standalone gg.pim.jetstream.project action stays registered for already-installed profiles.
  project: {
    uuid: 'gg.pim.jetstream.slot',
    name: 'Project status',
    build: (f) => {
      const path = str(f.path);
      if (!path) return { error: 'project needs "path"' };
      return { settings: { kind: 'project', path, ...(str(f.name) ? { name: str(f.name) } : {}), ...slotCosmetics(f) } };
    },
  },
  approve: { uuid: 'gg.pim.jetstream.permission', name: 'Approve', build: () => ({ settings: { decision: 'allow' } }) },
  deny: { uuid: 'gg.pim.jetstream.permission', name: 'Deny', build: () => ({ settings: { decision: 'deny' } }) },
  nav: {
    uuid: 'gg.pim.jetstream.nav',
    name: 'Page nav',
    build: (f) => ({ settings: { target: str(f.target) === 'board' ? 'board' : 'ops' } }),
  },
  // ── Jetstream keys with no settings ──
  ...Object.fromEntries(
    Object.entries(NO_SETTINGS).map(([type, uuid]) => [type, { uuid, name: NO_SETTINGS_NAMES[type] ?? type }]),
  ),
  // ── FOLDED into the plugin-owned slot so they MOVE LIVE (POST /slot), no profile re-import. These
  //    entries OVERRIDE the native-uuid ones from the NO_SETTINGS spread above; the keys stay IN
  //    NO_SETTINGS only so NO_SETTINGS_TYPE_NAMES (the prompt catalogue) + the drift test still list
  //    them. See docs/slot-kinds-scoping.md. ──
  build: {
    uuid: 'gg.pim.jetstream.slot',
    name: 'Build version',
    build: (f) => ({ settings: { kind: 'build', ...slotCosmetics(f) } }),
  },
  'stop-all': {
    uuid: 'gg.pim.jetstream.slot',
    name: 'Stop all',
    build: (f) => ({ settings: { kind: 'stopall', ...slotCosmetics(f) } }),
  },
  fleet: {
    uuid: 'gg.pim.jetstream.slot',
    name: 'Fleet roll-up',
    build: (f) => ({ settings: { kind: 'fleet', ...slotCosmetics(f) } }),
  },
  // Output-volume keys (macOS): move/mute the default output; work on a volume-fixed interface once a
  // virtual gain device like Background Music sits in front. Slot kinds → live-placeable, no import.
  volup: { uuid: 'gg.pim.jetstream.slot', name: 'Volume up', build: (f) => ({ settings: { kind: 'volup', ...slotCosmetics(f) } }) },
  voldown: { uuid: 'gg.pim.jetstream.slot', name: 'Volume down', build: (f) => ({ settings: { kind: 'voldown', ...slotCosmetics(f) } }) },
  volmute: { uuid: 'gg.pim.jetstream.slot', name: 'Mute output', build: (f) => ({ settings: { kind: 'volmute', ...slotCosmetics(f) } }) },
  // Opens `jetstream chat` in a terminal — the board builder needs an interactive TTY.
  chat: { uuid: 'gg.pim.jetstream.slot', name: 'Build by chat', build: (f) => ({ settings: { kind: 'chat', ...slotCosmetics(f) } }) },
};

/** The placeable type names, for the model prompt + "unknown type" messages. */
export const KEY_TYPE_NAMES: readonly string[] = Object.keys(KEY_TYPES);

/** "a8" → { column, row } — row = letter (a = top), column = 1-indexed number — validated against
 * the deck's grid. Null for an unparseable or off-board coordinate. Inverse of `coordLabel`. */
export function parseCoord(label: string, deck: DeckModel): { column: number; row: number } | null {
  const m = /^\s*([a-z])\s*(\d+)\s*$/i.exec(label);
  if (!m) return null;
  const row = m[1]!.toLowerCase().charCodeAt(0) - 97; // 'a' → 0
  const column = Number(m[2]) - 1; // 1-indexed → 0-indexed
  if (row < 0 || row >= deck.rows || column < 0 || column >= deck.cols) return null;
  return { column, row };
}

export interface Placement {
  column: number;
  row: number;
  uuid: string;
  name: string;
  settings: Record<string, unknown> | null;
}

export interface ResolvedLayout {
  placements: Placement[];
  /** Human-readable reasons keys were dropped (unknown type, off-board coord, missing settings,
   * a coordinate already taken) — surfaced to the user so a silent drop never masquerades as done. */
  warnings: string[];
}

/** Validate + build the model's proposed keys into concrete placements. Never throws: an unknown
 * type, bad coordinate, missing required settings, or a duplicate coordinate is DROPPED with a
 * warning, so the model can't smuggle a malformed key onto the deck. */
export function resolvePlacements(deck: DeckModel, keys: unknown): ResolvedLayout {
  const placements: Placement[] = [];
  const warnings: string[] = [];
  const taken = new Set<string>();
  if (!Array.isArray(keys)) return { placements, warnings };
  for (const raw of keys) {
    if (typeof raw !== 'object' || raw === null) continue;
    const k = raw as Record<string, unknown>;
    const coordLabel = typeof k.coord === 'string' ? k.coord : '';
    const typeName = typeof k.type === 'string' ? k.type.toLowerCase() : '';
    const at = coordLabel || '(no coord)';
    const type = KEY_TYPES[typeName];
    if (!type) {
      warnings.push(`skipped ${typeName || '(no type)'} at ${at}: unknown key type`);
      continue;
    }
    const coord = parseCoord(coordLabel, deck);
    if (!coord) {
      warnings.push(`skipped ${typeName} at ${at}: off the ${deck.key} board (${deck.cols}×${deck.rows})`);
      continue;
    }
    const slot = `${coord.column},${coord.row}`;
    if (taken.has(slot)) {
      warnings.push(`skipped ${typeName} at ${coordLabel}: ${coordLabel} is already taken`);
      continue;
    }
    let settings: Record<string, unknown> | null = null;
    if (type.build) {
      const result = type.build(k);
      if ('error' in result) {
        warnings.push(`skipped ${typeName} at ${coordLabel}: ${result.error}`);
        continue;
      }
      settings = result.settings;
    }
    taken.add(slot);
    placements.push({ column: coord.column, row: coord.row, uuid: type.uuid, name: type.name, settings });
  }
  return { placements, warnings };
}
