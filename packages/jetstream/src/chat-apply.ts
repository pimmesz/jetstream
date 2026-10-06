import { isDeepStrictEqual } from 'node:util';
import { labelForAction, legacyMigrations, type BoardLayout } from './board-layout';
import type { Placement } from './layout';
import type { InPlaceResult } from './profile-store';
import { coordLabel } from './slot-command';

/**
 * How `jetstream chat` lands an approved layout. A key that only changes a Jetstream slot already on
 * the board goes LIVE (the plugin retargets it, no restart). Anything else (a new native or
 * third-party key, a legacy key, the plugin being down) is written straight into the board's
 * profile while Stream Deck restarts, so no "Jetstream Custom copy N" profile ever appears.
 */

const SLOT = 'gg.pim.jetstream.slot';

export type Route = 'same' | 'live' | 'restart';

export interface PlannedKey {
  placement: Placement;
  route: Route;
  coord: string;
  /** What sits there now, for the preview ("Telegram", "empty"). */
  before: string;
  /** What will sit there ("Philips Hue power", "empty"). */
  after: string;
}

/** A short label for a placement: Jetstream and built-in keys by their settings, a copied
 * third-party key by its catalogue title. */
function placementLabel(p: Placement): string {
  if (p.uuid.startsWith('gg.pim.jetstream.') || p.uuid.startsWith('com.elgato.streamdeck.')) {
    const label = labelForAction(p.uuid, p.settings);
    return label === '·' ? 'empty' : label;
  }
  return p.name;
}

/** Decide, per key, whether it changes nothing, can go live, or needs the restart write. Pure. */
export function planLayout(board: BoardLayout | null, placements: Placement[]): PlannedKey[] {
  return placements.map((p) => {
    const existing = board?.keys.get(`${p.column},${p.row}`);
    const before = existing ? (existing.label === '·' ? 'empty' : existing.label) : 'empty';
    const unchanged =
      existing !== undefined &&
      existing.uuid === p.uuid &&
      isDeepStrictEqual(existing.settings ?? null, p.settings ?? null);
    const route: Route = unchanged ? 'same' : existing?.uuid === SLOT && p.uuid === SLOT ? 'live' : 'restart';
    return { placement: p, route, coord: coordLabel(p.column, p.row), before, after: placementLabel(p) };
  });
}

/** One preview line per changed key, for the Apply prompt. */
export function describePlan(plan: PlannedKey[]): string[] {
  return plan
    .filter((k) => k.route !== 'same')
    .map((k) => `  ${k.coord}: ${k.after} (was: ${k.before})${k.route === 'restart' ? '  [needs a Stream Deck restart]' : ''}`);
}

export interface ApplyDeps {
  say: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  board: BoardLayout | null;
  /** The board as it is right now. Live edits land on the page on screen, so a plan made for another
   * page must not be applied. Absent: no check. */
  boardOnScreen?: () => BoardLayout | null;
  pluginAlive: () => Promise<boolean>;
  /** POST one slot edit to the running plugin; the HTTP status (-1 when there was no answer). */
  sendSlot: (command: Record<string, unknown>) => Promise<number>;
  /** The in-place profile writer, or undefined where it cannot run (not macOS). */
  writeInPlace?: (profileDir: string, placements: Placement[], pageId?: string) => Promise<InPlaceResult>;
  /** Last resort without a board to write into: an importable profile file. Returns its path. */
  importProfile: (placements: Placement[]) => string;
}

export type ApplyOutcome = 'unchanged' | 'live' | 'restarted' | 'imported' | 'declined' | 'failed';

/** Why a live edit was refused, in words that point at the real fix. */
function liveFailure(status: number): string {
  if (status === 401) return 'the plugin refused the request (token mismatch); restart the Stream Deck app';
  if (status === 404) return 'that key is not on the Stream Deck page on screen';
  if (status === -1) return 'the plugin did not answer';
  return `the plugin rejected it (HTTP ${status})`;
}

const isClear = (p: Placement): boolean => p.uuid === SLOT && (p.settings as { kind?: unknown } | null)?.kind === 'empty';

interface LiveResult {
  ok: boolean;
  failures: string[];
  /** Keys that changed live but could not be put back after another key failed. */
  unrestored: string[];
}

/** Answers that prove the plugin changed nothing. Any other failure (a 500 after the settings were saved,
 * no answer at all) may have changed the key, so it is rolled back like a success. */
const UNTOUCHED = new Set([400, 401, 404]);

async function sendLive(keys: PlannedKey[], deps: ApplyDeps): Promise<LiveResult> {
  const touched: PlannedKey[] = [];
  const send = async (k: PlannedKey): Promise<string | undefined> => {
    const status = await deps.sendSlot({ coord: k.coord, ...(k.placement.settings ?? {}) });
    if (!UNTOUCHED.has(status)) touched.push(k);
    return status === 200 ? undefined : `${k.coord}: ${liveFailure(status)}`;
  };
  // Destinations first, clears only once every destination landed: a move must never clear its source
  // while the key it moved is still nowhere.
  let failures = (await Promise.all(keys.filter((k) => !isClear(k.placement)).map(send))).filter(Boolean);
  if (failures.length === 0) {
    failures = (await Promise.all(keys.filter((k) => isClear(k.placement)).map(send))).filter(Boolean);
  }
  if (failures.length === 0) return { ok: true, failures: [], unrestored: [] };
  // All or nothing: put back every key that already changed, so a half-done swap cannot leave the
  // same key on two coordinates and lose the other.
  const unrestored: string[] = [];
  for (const k of touched) {
    const original = deps.board?.keys.get(`${k.placement.column},${k.placement.row}`)?.settings ?? { kind: 'empty' };
    if ((await deps.sendSlot({ coord: k.coord, ...original })) !== 200) unrestored.push(k.coord);
  }
  return { ok: false, failures: failures as string[], unrestored };
}

/** Apply an approved layout and tell the user exactly what happened. */
export async function applyLayout(placements: Placement[], deps: ApplyDeps): Promise<ApplyOutcome> {
  const plan = planLayout(deps.board, placements);
  const changes = plan.filter((k) => k.route !== 'same');
  if (changes.length === 0) {
    deps.say('\nAlready set, nothing to change.');
    return 'unchanged';
  }
  const onScreen = deps.board ? deps.boardOnScreen?.() : undefined;
  if (deps.board && onScreen && (onScreen.profileDir !== deps.board.profileDir || onScreen.pageId !== deps.board.pageId)) {
    deps.say('\nStream Deck now shows a different page or profile than this plan was made for, so nothing changed.');
    deps.say('Send the request again to plan it for the board on screen.');
    return 'failed';
  }
  const receipt = (): void => {
    for (const k of changes) deps.say(`  ✓ ${k.coord}: ${k.after}`);
  };

  if (deps.board && changes.every((k) => k.route === 'live')) {
    if (await deps.pluginAlive()) {
      const live = await sendLive(changes, deps);
      if (live.ok) {
        deps.say('\nApplied live:');
        receipt();
        return 'live';
      }
      deps.say(`\nCould not apply live (${live.failures.join('; ')}).`);
      if (live.unrestored.length > 0) {
        deps.say(`These keys changed and could not be put back: ${live.unrestored.join(', ')}.`);
      }
    } else {
      deps.say('\nThe Jetstream plugin is not answering, so this cannot go live.');
    }
  }

  if (deps.board && deps.writeInPlace) {
    const ok = await deps.confirm(
      `This needs Stream Deck to restart (about 5 seconds; "${deps.board.profileName}" is backed up first). Go ahead?`,
    );
    if (!ok) {
      deps.say('Nothing changed.');
      return 'declined';
    }
    // Fold the board's legacy keys into the same restart, so their later edits apply live.
    const edited = new Set(changes.map((k) => k.coord));
    const migrations = legacyMigrations(deps.board).filter((m) => !edited.has(coordLabel(m.column, m.row)));
    const result = await deps.writeInPlace(
      deps.board.profileDir,
      [...migrations, ...changes.map((k) => k.placement)],
      deps.board.pageId,
    );
    if (result.ok) {
      deps.say(`\nUpdated "${deps.board.profileName}" and restarted Stream Deck:`);
      receipt();
      if (result.removed.length > 0) {
        deps.say(`  Removed ${result.removed.length} leftover "Jetstream Custom" profile copies.`);
      }
      deps.say(`  (backup: ${result.backup})`);
      return 'restarted';
    }
    deps.say(`\nCould not update the profile in place: ${result.reason}. Your board was not changed.`);
    return 'failed';
  }

  const path = deps.importProfile(placements);
  deps.say(`\nOpened ${path}: confirm the import in Stream Deck once (it adds a new profile).`);
  return 'imported';
}
