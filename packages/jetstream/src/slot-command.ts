import { normalizeColor } from './slot-color';
import type { SlotKind, SlotSettings } from './actions/slot';

/** A validated `POST /slot` command: where to put the key and its full replacement settings. */
export interface SlotCommand {
  coord: string;
  column: number;
  row: number;
  settings: SlotSettings;
}

const KINDS: readonly SlotKind[] = [
  'empty', 'app', 'url', 'run', 'build', 'stopall', 'model', 'fleet', 'volup', 'voldown', 'volmute',
];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Only http(s) URLs may be opened — blocks `file:`, `javascript:`, custom schemes. */
export function isHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** "a8" → {column:7,row:0}; row = letter (a = top), column = 1-indexed number. Deliberately NOT
 * bound-checked against a deck — the IPC matches whatever key instances are actually visible, not a
 * fixed grid. Null when unparseable. Inverse of `coordLabel`. */
export function coordToCell(label: string): { column: number; row: number } | null {
  const m = /^\s*([a-z])\s*(\d+)\s*$/i.exec(label);
  if (!m) return null;
  const row = m[1]!.toLowerCase().charCodeAt(0) - 97; // 'a' → 0
  const column = Number(m[2]) - 1; // 1-indexed → 0-indexed
  if (row < 0 || column < 0) return null;
  return { column, row };
}

/**
 * Validate an untrusted `POST /slot` body into a SlotCommand, or null (→ 400). Whitelists `kind`,
 * requires the per-kind target, http-only for URLs, and only a `string[]` for run args — mirroring
 * the layout designer's "the caller can't smuggle a malformed key" stance. The resulting settings
 * are a FULL replacement (setSettings overwrites), so a retarget never leaves stale fields behind.
 */
export function parseSlotCommand(raw: unknown): SlotCommand | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const coord = str(r.coord);
  if (!coord) return null;
  const cell = coordToCell(coord);
  if (!cell) return null;
  const kind = KINDS.includes(r.kind as SlotKind) ? (r.kind as SlotKind) : undefined;
  if (!kind) return null;
  const label = str(r.label);
  const icon = str(r.icon); // custom key image (data: URI or image path); app slots self-icon without it
  const sub = str(r.sub);
  const glyph = str(r.glyph);
  const colorRaw = str(r.color);
  const color = colorRaw ? normalizeColor(colorRaw) : undefined; // hex or a known name; else dropped
  const extra = {
    ...(label ? { label } : {}),
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(sub ? { sub } : {}),
    ...(glyph ? { glyph } : {}),
  };

  let settings: SlotSettings;
  switch (kind) {
    case 'app': {
      const app = str(r.app);
      if (!app) return null;
      settings = { kind, app, ...extra };
      break;
    }
    case 'url': {
      const url = str(r.url);
      if (!url || !isHttpUrl(url)) return null;
      settings = { kind, url, ...extra };
      break;
    }
    case 'run': {
      const command = str(r.command);
      if (!command) return null;
      // args must be a pure string[] — reject anything that could coerce oddly into an argv slot.
      if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === 'string'))) return null;
      const args = Array.isArray(r.args) ? (r.args as string[]) : undefined;
      const cwd = str(r.cwd);
      settings = { kind, command, ...(args ? { args } : {}), ...(cwd ? { cwd } : {}), ...extra };
      break;
    }
    case 'build':
    case 'stopall':
    case 'model':
    case 'fleet':
    case 'volup':
    case 'voldown':
    case 'volmute':
      // No per-key fields — a live/static face. `stopall`'s destructive press is gated (allowStopKeys);
      // the rest (build/model/fleet/vol*) are inert/benign. Cosmetic overrides in `extra` are safe.
      settings = { kind, ...extra };
      break;
    default: // 'empty' — clear the key back to a self-labeling slot
      settings = { kind: 'empty' };
  }
  return { coord, column: cell.column, row: cell.row, settings };
}
