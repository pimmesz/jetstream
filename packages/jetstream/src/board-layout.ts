import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { coordLabel } from './actions/coord';
import type { Placement } from './layout';
import { DECK_MODELS, type DeckModel } from './profile';

export interface BoardKey {
  uuid: string;
  settings: Record<string, unknown> | null;
  label: string;
}

export interface BoardLayout {
  profileName: string;
  deck: DeckModel;
  /** `${col},${row}` → the placed key. */
  keys: Map<string, BoardKey>;
}

const JETSTREAM_LABELS: Record<string, string> = {
  fleet: 'fleet',
  attention: 'attn',
  usage: 'usage',
  ci: 'ci',
  settings: 'cfg',
  build: 'build',
  nav: 'nav',
  launch: 'launch',
  coord: 'coord',
  grid: 'grid',
  interruptall: 'stop',
  model: 'model',
  heartbeat: 'beat',
  review: 'review',
  dial: 'dial',
  slot: 'slot',
};

const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** A short human label for a placed action (project name, launched app, "fleet", …). Pure. */
export function labelForAction(uuid: string, settings: unknown): string {
  const s = (typeof settings === 'object' && settings !== null ? settings : {}) as Record<string, unknown>;
  if (uuid === 'gg.pim.jetstream.project') {
    return asStr(s.name) ?? (asStr(s.path) ? basename(asStr(s.path)!) : 'project');
  }
  if (uuid === 'com.elgato.streamdeck.system.open') {
    const raw = asStr(s.path);
    if (!raw) return 'open';
    // system.open stores the path JSON-wrapped in literal quotes: "\"/Applications/Telegram.app\"".
    return basename(raw.replace(/^"+|"+$/g, '')).replace(/\.app$/i, '') || 'open';
  }
  if (uuid === 'com.elgato.streamdeck.system.website') {
    const url = asStr(s.path);
    if (!url) return 'url';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url.slice(0, 12);
    }
  }
  if (uuid === 'com.elgato.streamdeck.system.text') {
    return (asStr(s.pastedText) ?? 'text').slice(0, 8);
  }
  if (uuid === 'gg.pim.jetstream.permission') {
    return s.decision === 'deny' ? 'deny' : 'approve';
  }
  if (uuid === 'gg.pim.jetstream.slot') {
    const label = asStr(s.label);
    if (label) return label;
    if (s.kind === 'app') {
      const app = asStr(s.app);
      return app ? basename(app.replace(/^"+|"+$/g, '')).replace(/\.app$/i, '') || 'open' : 'open';
    }
    if (s.kind === 'url') {
      const url = asStr(s.url);
      if (!url) return 'url';
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return url.slice(0, 12);
      }
    }
    if (s.kind === 'run') return asStr(s.command) ?? 'run';
    return '·'; // empty slot
  }
  const seg = uuid.split('.').pop() ?? uuid;
  if (uuid.startsWith('gg.pim.jetstream.')) return JETSTREAM_LABELS[seg] ?? seg;
  return seg;
}

function defaultProfilesDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'com.elgato.StreamDeck', 'ProfilesV3');
}

/** Merge every keypad controller/page of a .sdProfile into one `col,row` → placed action map. */
function readProfileActions(
  profileDir: string,
): { model: string; actions: Record<string, { UUID?: unknown; Settings?: unknown }> } | null {
  let device: { Device?: { Model?: unknown } };
  try {
    device = JSON.parse(readFileSync(join(profileDir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  const model = typeof device.Device?.Model === 'string' ? device.Device.Model : '';
  const actions: Record<string, { UUID?: unknown; Settings?: unknown }> = {};
  const pagesDir = join(profileDir, 'Profiles');
  if (existsSync(pagesDir)) {
    for (const page of readdirSync(pagesDir)) {
      const pm = join(pagesDir, page, 'manifest.json');
      if (!existsSync(pm)) continue;
      try {
        const parsed = JSON.parse(readFileSync(pm, 'utf8')) as {
          Controllers?: Array<{ Actions?: Record<string, unknown> }>;
        };
        for (const controller of parsed.Controllers ?? []) {
          for (const [coord, act] of Object.entries(controller.Actions ?? {})) {
            if (!(coord in actions)) actions[coord] = act as { UUID?: unknown; Settings?: unknown };
          }
        }
      } catch {
        /* skip a corrupt page */
      }
    }
  }
  return { model, actions };
}

/** How many CONFIGURED (non-empty) keys a profile has — the yardstick for "the real board" when
 * deciding which duplicate to keep. Empty slots and unreadable profiles count as 0. */
function countConfiguredKeys(profileDir: string): number {
  const read = readProfileActions(profileDir);
  if (!read) return 0;
  let n = 0;
  for (const act of Object.values(read.actions)) {
    const uuid = typeof act.UUID === 'string' ? act.UUID : '';
    if (!uuid) continue;
    const s = (act.Settings && typeof act.Settings === 'object' ? act.Settings : {}) as Record<string, unknown>;
    if (uuid === 'gg.pim.jetstream.slot' && (s.kind ?? 'empty') === 'empty') continue;
    n++;
  }
  return n;
}

/** Delete redundant "Jetstream Custom" profiles from the store, KEEPING the one with the most
 * configured keys (the real board). No-op when 0-1 exist. Only ever touches our own generated
 * "Jetstream Custom*" profiles — never the user's own — and never the kept board, so the active
 * layout is safe. Returns the removed dir basenames. (Stream Deck's in-memory duplicates clear on its
 * next restart; this stops the on-disk store from accumulating.) */
export function pruneCustomProfiles(profilesDir: string = defaultProfilesDir()): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(profilesDir).filter((d) => d.endsWith('.sdProfile'));
  } catch {
    return [];
  }
  const customs: Array<{ dir: string; configured: number }> = [];
  for (const dir of dirs) {
    const profileDir = join(profilesDir, dir);
    let name = '';
    try {
      name = String(
        (JSON.parse(readFileSync(join(profileDir, 'manifest.json'), 'utf8')) as { Name?: unknown }).Name ?? '',
      );
    } catch {
      continue;
    }
    // EXACT match on our own generated names + Stream Deck's copy suffixes ("copy", "copy 2"). A
    // prefix match would also catch a user's own "Jetstream Custom Work" profile and delete it.
    if (!/^jetstream custom( copy( \d+)?)?$/i.test(name)) continue;
    customs.push({ dir: profileDir, configured: countConfiguredKeys(profileDir) });
  }
  if (customs.length <= 1) return [];
  const max = Math.max(...customs.map((c) => c.configured));
  const removed: string[] = [];
  // Delete only profiles with STRICTLY fewer configured keys than the richest one. On a tie for the
  // max, keep ALL of them — the active board is always among the richest, so it can never be deleted.
  for (const c of customs) {
    if (c.configured >= max) continue;
    try {
      rmSync(c.dir, { recursive: true, force: true });
      removed.push(basename(c.dir));
    } catch {
      /* skip a dir we can't remove */
    }
  }
  return removed;
}

/** Read the user's current Jetstream board from the Stream Deck profile store; null if none found.
 * Best-effort (never throws): picks the profile with the most CONFIGURED keys (project keys AND
 * non-empty shortcut slots, so a shortcuts-only board still counts), excluding the Grid/Ops overlays,
 * and matches the device to a DeckModel by model-code prefix (an XL is 20GAT99xx). */
export function readBoardLayout(profilesDir: string = defaultProfilesDir()): BoardLayout | null {
  let dirs: string[];
  try {
    dirs = readdirSync(profilesDir).filter((d) => d.endsWith('.sdProfile'));
  } catch {
    return null;
  }
  let best: BoardLayout | null = null;
  let bestConfigured = 0;
  for (const dir of dirs) {
    const profileDir = join(profilesDir, dir);
    let name = '';
    try {
      name = String(
        (JSON.parse(readFileSync(join(profileDir, 'manifest.json'), 'utf8')) as { Name?: unknown }).Name ?? '',
      );
    } catch {
      continue;
    }
    if (/grid|ops/i.test(name)) continue; // the coordinate/controls overlays, not a board
    const read = readProfileActions(profileDir);
    if (!read) continue;
    const deck = DECK_MODELS.find((d) => d.model.slice(0, 7) === read.model.slice(0, 7));
    if (!deck) continue;
    const keys = new Map<string, BoardKey>();
    let configured = 0;
    for (const [coord, act] of Object.entries(read.actions)) {
      const uuid = typeof act.UUID === 'string' ? act.UUID : '';
      if (!uuid) continue;
      const settings =
        act.Settings && typeof act.Settings === 'object' ? (act.Settings as Record<string, unknown>) : null;
      const isConfigured =
        (uuid === 'gg.pim.jetstream.project' && Boolean(asStr(settings?.path))) ||
        (uuid === 'gg.pim.jetstream.slot' && (settings?.kind ?? 'empty') !== 'empty');
      if (isConfigured) configured++;
      keys.set(coord, { uuid, settings, label: labelForAction(uuid, settings) });
    }
    if (configured > bestConfigured) {
      best = { profileName: name, deck, keys };
      bestConfigured = configured;
    }
  }
  return best;
}

/** The full board as an aligned grid — every key in its place, `coordinate label`, empty slots as `·`.
 * Each COLUMN is sized to its widest cell so long project names aren't truncated and columns still
 * line up (mirrors the physical deck: 8 across, 4 down for an XL). `paintCoord` styles the coordinate
 * token (e.g. colour it by row); it defaults to identity, and since column widths are measured on the
 * PLAIN text the colouring never disturbs alignment. */
export function renderBoardMap(
  layout: BoardLayout,
  paintCoord: (coord: string, row: number) => string = (c) => c,
): string {
  const { deck, keys } = layout;
  const cellText = (col: number, row: number): string =>
    `${coordLabel(col, row)} ${keys.get(`${col},${row}`)?.label ?? '·'}`;
  const colWidth: number[] = [];
  for (let col = 0; col < deck.cols; col++) {
    let width = 0;
    for (let row = 0; row < deck.rows; row++) width = Math.max(width, cellText(col, row).length);
    colWidth[col] = width;
  }
  const lines: string[] = [];
  for (let row = 0; row < deck.rows; row++) {
    const cells: string[] = [];
    for (let col = 0; col < deck.cols; col++) {
      const padded = cellText(col, row).padEnd(colWidth[col]!);
      const coord = coordLabel(col, row);
      // Colour the coordinate prefix in place — padding was sized on the plain cell, so alignment holds.
      cells.push(paintCoord(coord, row) + padded.slice(coord.length));
    }
    lines.push(`  ${cells.join('  ').trimEnd()}`);
  }
  return lines.join('\n');
}

/** Convert a native Elgato open/website key into the equivalent plugin-owned slot, so a rebuilt or
 * imported board becomes fully plugin-owned (hence live-editable). Returns null for anything already
 * a Jetstream key, or a native type we don't migrate (e.g. text). Pure. */
export function toSlotKey(
  uuid: string,
  settings: unknown,
): { uuid: string; settings: Record<string, unknown> } | null {
  const s = (typeof settings === 'object' && settings !== null ? settings : {}) as Record<string, unknown>;
  if (uuid === 'com.elgato.streamdeck.system.open') {
    const app = asStr(s.path)?.replace(/^"+|"+$/g, ''); // system.open stores the path quote-wrapped
    return app ? { uuid: 'gg.pim.jetstream.slot', settings: { kind: 'app', app, label: labelForAction(uuid, s) } } : null;
  }
  if (uuid === 'com.elgato.streamdeck.system.website') {
    const url = asStr(s.path);
    return url ? { uuid: 'gg.pim.jetstream.slot', settings: { kind: 'url', url } } : null;
  }
  return null;
}

/** Overlay the chat's edits onto the current board: keep every existing key (migrating native
 * open/website keys to slots so the whole board is plugin-owned), then apply each edit at its
 * coordinate (add or replace) — so "put X at a8" preserves the rest of the board. When there is no
 * current board, it's just the edits (a from-scratch layout). */
export function mergeBoard(board: BoardLayout | null, edits: Placement[]): Placement[] {
  const byCoord = new Map<string, Placement>();
  if (board) {
    for (const [coord, k] of board.keys) {
      const [cs, rs] = coord.split(',');
      const migrated = toSlotKey(k.uuid, k.settings);
      byCoord.set(coord, {
        column: Number(cs),
        row: Number(rs),
        uuid: migrated?.uuid ?? k.uuid,
        name: migrated ? labelForAction(migrated.uuid, migrated.settings) : k.label,
        settings: migrated?.settings ?? k.settings,
      });
    }
  }
  for (const p of edits) byCoord.set(`${p.column},${p.row}`, p);
  return [...byCoord.values()];
}

/** A re-emittable, one-per-line description of a configured key for the chat model: its chat `type`
 * + identifying fields + any cosmetic overrides already set — enough that the model can reproduce the
 * key (to tweak or move it) without dropping its target or existing styling. `'empty'` for a blank slot. */
export function describeKeyForModel(k: BoardKey): string {
  const s = (k.settings ?? {}) as Record<string, unknown>;
  // Round-trip EVERY behaviour + cosmetic field, so re-emitting a key to tweak/move it never drops
  // its args, cwd, or custom icon (a full setSettings would otherwise wipe them).
  const extra = (['label', 'color', 'sub', 'glyph', 'icon'] as const)
    .map((f) => (asStr(s[f]) ? ` ${f}="${asStr(s[f])}"` : ''))
    .join('');
  if (k.uuid === 'gg.pim.jetstream.slot') {
    if (s.kind === 'app') return `open-app app="${asStr(s.app) ?? ''}"${extra}`;
    if (s.kind === 'url') return `open-url url="${asStr(s.url) ?? ''}"${extra}`;
    if (s.kind === 'run') {
      const args = Array.isArray(s.args) ? ` args=${JSON.stringify(s.args)}` : '';
      const cwd = asStr(s.cwd) ? ` cwd="${asStr(s.cwd)}"` : '';
      return `run command="${asStr(s.command) ?? ''}"${args}${cwd}${extra}`;
    }
    return extra ? `slot${extra}` : 'empty';
  }
  if (k.uuid === 'gg.pim.jetstream.project') {
    return `project path="${asStr(s.path) ?? ''}"${asStr(s.name) ? ` name="${asStr(s.name)}"` : ''}`;
  }
  if (k.uuid === 'gg.pim.jetstream.permission') return s.decision === 'deny' ? 'deny' : 'approve';
  if (k.uuid === 'gg.pim.jetstream.nav') return 'nav';
  return k.label; // other Jetstream keys: the label IS the chat type name (fleet/usage/…)
}

/** A description of the board for the chat model so it can add, replace, TWEAK, or MOVE keys by
 * coordinate against what's already there — each configured key shown with enough to reproduce it. */
export function boardContext(board: BoardLayout): string {
  const rows: string[] = [];
  for (const [coord, k] of board.keys) {
    const desc = describeKeyForModel(k);
    if (desc === 'empty') continue;
    const [cs, rs] = coord.split(',');
    rows.push(`  ${coordLabel(Number(cs), Number(rs))}: ${desc}`);
  }
  return [
    `The user's current ${board.deck.label} board. These coordinates are configured; EVERY OTHER coordinate is an empty slot you can fill:`,
    ...rows,
    `Propose a "layout" (deck="${board.deck.key}") whose "keys" are ONLY the coordinates to add, replace, or tweak — the rest of the board is preserved.`,
    `To TWEAK an existing key (colour / rename / subtitle / emoji), re-emit that SAME key using its type + fields above PLUS your change. To MOVE a key, emit it at the new coordinate and also emit {"coord":"<old>","type":"slot"} to clear the old spot.`,
  ].join('\n');
}
