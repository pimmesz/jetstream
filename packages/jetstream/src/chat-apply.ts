import { isDeepStrictEqual } from 'node:util';
import { labelForAction, legacyMigrations, type BoardKey, type BoardLayout } from './board-layout';
import { stripControl } from './fleet';
import type { Placement } from './layout';
import type { InPlaceResult, StoredAction } from './profile-store';
import { coordLabel, parseSlotCommand, sameSlot, storedSlotSettings } from './slot-command';

/**
 * How `jetstream chat` lands an approved layout. A key that only changes a Jetstream slot already on
 * the board goes LIVE (the plugin retargets it, no restart). Anything else (a new native or
 * third-party key, a legacy key, the plugin being down) is written straight into the board's
 * profile while Stream Deck restarts, so no "Jetstream Custom copy N" profile ever appears.
 */

export const SLOT = 'gg.pim.jetstream.slot';

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
  // The board label keeps 8 characters of a Text key; the preview shows 40, so the user sees what it will type.
  // A longer text ends in an ellipsis, so a cut command never reads as the whole thing.
  if (p.uuid === 'com.elgato.streamdeck.system.text') {
    const text = p.settings?.pastedText;
    const shown = typeof text === 'string' ? stripControl(text).trim() : '';
    return (shown.length > 40 ? `${shown.slice(0, 39)}…` : shown) || 'text';
  }
  if (p.uuid.startsWith('gg.pim.jetstream.') || p.uuid.startsWith('com.elgato.streamdeck.')) {
    const label = labelForAction(p.uuid, p.settings);
    return label === '·' ? 'empty' : label;
  }
  return p.name;
}

/** A board key laid over from chat's pending store: a live edit Stream Deck may since have lost. */
export interface PendingKey extends BoardKey {
  isPending: true;
  /** The stored edit this key was laid over from, so a 409 forgets that edit and never a newer one. */
  from?: { at: number; pid: number };
}

const isPendingKey = (key: BoardKey): boolean => 'isPending' in key && key.isPending === true;

/** Decide, per key, whether it changes nothing, can go live, or needs the restart write. Pure. */
export function planLayout(board: BoardLayout | null, placements: Placement[]): PlannedKey[] {
  return placements.map((p) => {
    const existing = board?.keys.get(`${p.column},${p.row}`);
    const before = existing ? (existing.label === '·' ? 'empty' : existing.label) : 'empty';
    // A pending key is sent again, never skipped: the plugin's compare then confirms it (200) or refuses (409)
    // before any key is cleared.
    const unchanged =
      existing !== undefined &&
      !isPendingKey(existing) &&
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
  /** The in-place profile writer, or undefined where it cannot run (not macOS). `changedSincePlan` must
   * reach the writer: it is how a key changed after the plan stops the write. */
  writeInPlace?: (
    profileDir: string,
    placements: Placement[],
    pageId: string | undefined,
    changedSincePlan: (actions: Record<string, StoredAction>) => string[],
  ) => Promise<InPlaceResult>;
  /** Last resort without a board to write into: an importable profile file. Returns its path. */
  importProfile: (placements: Placement[]) => string;
  /** Told the board keys (`column,row`) the plugin refused because they hold something else (409). */
  onConflict?: (keys: string[]) => void;
}

/** `reloaded`: Stream Deck restarted but the write was called off, so the page shows what disk holds. */
export type ApplyOutcome = 'unchanged' | 'live' | 'restarted' | 'reloaded' | 'imported' | 'declined' | 'failed';

/** Why a live edit was refused, in words that point at the real fix. */
function liveFailure(status: number): string {
  // 401: a token mismatch, or a plugin older than this CLI.
  if (status === 401)
    return 'Jetstream on your Stream Deck did not accept this change; restart the Stream Deck app, and if that does not help, run jetstream update';
  if (status === 404) return 'that key is not on the Stream Deck page you have open (or you have two Stream Decks of the same model)';
  if (status === 409) return 'that key changed on your deck after I made this plan';
  if (status === -1) return 'Jetstream on your Stream Deck did not answer';
  return `Jetstream on your Stream Deck refused it (error ${status})`;
}

const isClear = (p: Placement): boolean => p.uuid === SLOT && (p.settings as { kind?: unknown } | null)?.kind === 'empty';

interface LiveResult {
  ok: boolean;
  failures: string[];
  /** Keys that changed live and whose undo, after another key failed, was not confirmed. */
  unrestored: string[];
  /** Styled empty keys put back without their colour, label or icon: /slot never stores those on an empty key. */
  stripped: string[];
  /** Board keys that held something else than the plan saw there (a 409). */
  conflicts: string[];
}

/** Answers that prove the plugin changed nothing. Any other failure (a 500 after the settings were saved,
 * no answer at all) may have changed the key, so it is rolled back like a success. */
const UNTOUCHED = new Set([400, 401, 404, 409]);

/** Live edits in flight at once. Each makes the plugin draw its key against a fixed deadline, so a large
 * edit sent all at once can time out and roll back for no real reason. */
const LIVE_IN_FLIGHT = 4;

/** `run` over every item with at most `limit` in flight; results in input order. */
async function mapPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function sendLive(keys: PlannedKey[], deps: ApplyDeps, confirms: PlannedKey[] = []): Promise<LiveResult> {
  const touched: PlannedKey[] = [];
  const conflicts: string[] = [];
  // The same coordinate exists on every connected deck, so name the model this plan is for. Sent after the
  // settings so no settings field can override it.
  const deck = deps.board?.deck.key;
  const send = async (k: PlannedKey, isConfirm = false): Promise<string | undefined> => {
    // `expect` is what the plan saw at this key; the plugin refuses the write if the deck now shows
    // something else there.
    const seen = deps.board?.keys.get(`${k.placement.column},${k.placement.row}`)?.settings ?? { kind: 'empty' };
    const status = await deps.sendSlot({ coord: k.coord, ...(k.placement.settings ?? {}), expect: seen, deck });
    // A confirm rewrites what the key already holds, so it never needs undoing.
    if (!isConfirm && !UNTOUCHED.has(status)) touched.push(k);
    if (status === 409) conflicts.push(`${k.placement.column},${k.placement.row}`);
    return status === 200 ? undefined : `${k.coord}: ${liveFailure(status)}`;
  };
  // Confirms first and on their own: a refused one stops the apply before any key changes. Then destinations,
  // and clears only once every destination landed: a move must never lose the key it moved.
  let failures = (await mapPool(confirms, LIVE_IN_FLIGHT, (k) => send(k, true))).filter(Boolean);
  if (failures.length === 0) {
    failures = (await mapPool(keys.filter((k) => !isClear(k.placement)), LIVE_IN_FLIGHT, (k) => send(k))).filter(Boolean);
  }
  if (failures.length === 0) {
    failures = (await mapPool(keys.filter((k) => isClear(k.placement)), LIVE_IN_FLIGHT, (k) => send(k))).filter(Boolean);
  }
  if (failures.length === 0) return { ok: true, failures: [], unrestored: [], stripped: [], conflicts: [] };
  // All or nothing: put back every key that already changed, so a half-done swap cannot leave the
  // same key on two coordinates and lose the other.
  const unrestored: string[] = [];
  const stripped: string[] = [];
  for (const k of touched) {
    const original = deps.board?.keys.get(`${k.placement.column},${k.placement.row}`)?.settings ?? { kind: 'empty' };
    // Only put it back while it still holds what we wrote; anything else there is not ours to undo.
    const ours = storedSlotSettings(k.placement.settings);
    // A never-configured slot ({}) goes back as the empty slot it shows. Any other original is sent as it was,
    // so one the plugin cannot parse is refused and reported below instead of being cleared.
    const restore = sameSlot(original, { kind: 'empty' }) ? { kind: 'empty' } : original;
    const status = await deps.sendSlot({ coord: k.coord, ...restore, expect: ours, deck });
    if (status !== 200 && status !== 409) unrestored.push(k.coord); // 409: not ours any more, nothing to undo
    if (status === 200 && original.kind === 'empty' && !sameSlot(original, { kind: 'empty' })) stripped.push(k.coord);
  }
  return { ok: false, failures: failures as string[], unrestored, stripped, conflicts };
}

/** What a failed live apply left changed on the deck, for the closing message; undefined when nothing. */
function leftoverNote(unrestored: string[], stripped: string[]): string | undefined {
  const notes = [
    ...(unrestored.length > 0 ? [`these keys may still hold the new settings: ${unrestored.join(', ')}`] : []),
    ...(stripped.length > 0 ? [`these keys lost their colour, label or icon: ${stripped.join(', ')}`] : []),
  ];
  return notes.length > 0 ? notes.join('; ') : undefined;
}

/** A key reduced to what the compare looks at; undefined when the coordinate holds no key. */
type DiskKey = { uuid: string; settings: unknown } | undefined;

/** Same action and settings. Slots compare the way the plugin compares them. Two missing keys match. */
function sameKey(a: DiskKey, b: DiskKey): boolean {
  if (!a || !b) return a === b;
  if (a.uuid !== b.uuid) return false;
  return a.uuid === SLOT ? sameSlot(a.settings, b.settings) : isDeepStrictEqual(a.settings, b.settings);
}

/** A slot as the plugin stores it. A live edit or its rollback leaves it this way. Settings the plugin refuses
 * (a scheme-less legacy url) never went live, so they stay as they are. */
function asStored(k: DiskKey): DiskKey {
  if (k?.uuid !== SLOT) return k;
  const settings = parseSlotCommand({ coord: 'a1', ...(k.settings as Record<string, unknown> | null) })?.settings;
  return settings ? { uuid: SLOT, settings } : k;
}

/** Keys the restart would overwrite although disk no longer shows them as the plan did. A key passes when it
 * holds what the plan saw there or what this write puts there, as sent or as the plugin stores it. Pure. */
export function changedSincePlan(
  board: BoardLayout,
  written: Placement[],
  actions: Record<string, StoredAction>,
): string[] {
  return written
    .filter((p) => {
      const coord = `${p.column},${p.row}`;
      const act = actions[coord];
      // Read the stored key the way readBoardLayout does, so an untouched key compares equal.
      const onDisk: DiskKey =
        typeof act?.UUID === 'string' && act.UUID !== ''
          ? { uuid: act.UUID, settings: typeof act.Settings === 'object' && act.Settings !== null ? act.Settings : null }
          : undefined;
      const allowed: DiskKey[] = [board.keys.get(coord), { uuid: p.uuid, settings: p.settings ?? null }];
      return !allowed.some((k) => sameKey(onDisk, k) || sameKey(onDisk, asStored(k)));
    })
    .map((p) => coordLabel(p.column, p.row));
}

/** Apply an approved layout and tell the user exactly what happened. */
export async function applyLayout(placements: Placement[], deps: ApplyDeps): Promise<ApplyOutcome> {
  const plan = planLayout(deps.board, placements);
  const changes = plan.filter((k) => k.route !== 'same');
  if (changes.length === 0) {
    deps.say('\nAlready set, nothing to change.');
    return 'unchanged';
  }
  // An unchanged key in a move is its destination as disk shows it, which the deck may no longer hold. Before
  // a key that holds something is cleared or replaced, every unchanged key the plan keeps is confirmed to
  // still hold what the plan saw (live by the plugin, slots only; on the restart route by the disk compare),
  // so a move can never lose its only copy.
  const isDestructive = (k: PlannedKey): boolean => {
    const existing = deps.board?.keys.get(`${k.placement.column},${k.placement.row}`);
    return existing !== undefined && !(existing.uuid === SLOT && sameSlot(existing.settings, { kind: 'empty' }));
  };
  const kept = changes.some(isDestructive) ? plan.filter((k) => k.route === 'same' && !isClear(k.placement)) : [];
  const confirms = kept.filter((k) => k.placement.uuid === SLOT);
  const onScreen = deps.board ? deps.boardOnScreen?.() : undefined;
  if (deps.board && onScreen && (onScreen.profileDir !== deps.board.profileDir || onScreen.pageId !== deps.board.pageId)) {
    deps.say('\nStream Deck now shows a different page or profile than this plan was made for, so nothing changed.');
    deps.say('Send the request again to plan it for the board on screen.');
    return 'failed';
  }
  const receipt = (): void => {
    for (const k of changes) deps.say(`  ✓ ${k.coord}: ${k.after}`);
  };

  let unrestored: string[] = [];
  let stripped: string[] = [];
  if (deps.board && changes.every((k) => k.route === 'live')) {
    if (await deps.pluginAlive()) {
      const live = await sendLive(changes, deps, confirms);
      unrestored = live.unrestored;
      stripped = live.stripped;
      if (live.ok) {
        deps.say('\nApplied live:');
        receipt();
        return 'live';
      }
      deps.say(`\nCould not change the keys right away (${live.failures.join('; ')}).`);
      if (live.conflicts.length > 0) {
        deps.onConflict?.(live.conflicts);
        // A restart would write the plan over an edit it never saw. Chat re-reads the board once the restart
        // is answered, so waiting before declining lets a late save reach the next plan.
        deps.say('Stream Deck may not have saved a recent edit yet, or another page is open.');
        deps.say('Wait 5 seconds, choose "Not now" at the next question, then send your request again.');
      }
      if (live.unrestored.length > 0) {
        deps.say(`Putting these keys back was not confirmed, so they may still hold the new settings: ${live.unrestored.join(', ')}.`);
      }
      if (live.stripped.length > 0) {
        deps.say(`Put back as plain empty keys, without their colour, label or icon: ${live.stripped.join(', ')}.`);
      }
    } else {
      deps.say('\nThe Jetstream plugin is not answering, so this cannot go live.');
    }
  }

  if (deps.board && deps.writeInPlace) {
    const ok = await deps.confirm(
      `Stream Deck must restart for about 5 seconds to apply this. "${deps.board.profileName}" is backed up first.`,
    );
    if (!ok) {
      const note = leftoverNote(unrestored, stripped);
      deps.say(note ? `Not restarted, so ${note}.` : 'Nothing changed.');
      return 'declined';
    }
    // Fold the board's legacy keys into the same restart, so their later edits apply live.
    const edited = new Set(changes.map((k) => k.coord));
    const migrations = legacyMigrations(deps.board).filter((m) => !edited.has(coordLabel(m.column, m.row)));
    // The callback runs after the quit, where TypeScript no longer sees deps.board as set.
    const board = deps.board;
    const written = [...migrations, ...changes.map((k) => k.placement)];
    // The confirmed keys are compared but not written: the restart leaves them as they are.
    const compared = [...written, ...kept.map((k) => k.placement)];
    const result = await deps.writeInPlace(board.profileDir, written, board.pageId, (actions) =>
      changedSincePlan(board, compared, actions),
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
    const note = leftoverNote(unrestored, stripped);
    const leftover = note ? `Apart from that nothing changed, but ${note}.` : 'Your board was not changed.';
    deps.say(`\nCould not change your board: ${result.reason}. ${leftover}`);
    if (result.changed) {
      deps.say('Stream Deck restarted, but nothing was written. Send the request again to plan it against the board as it is now.');
      return 'reloaded';
    }
    return 'failed';
  }

  const path = deps.importProfile(placements);
  deps.say(`\nOpened ${path}: confirm the import in Stream Deck once (it adds a new profile).`);
  return 'imported';
}
