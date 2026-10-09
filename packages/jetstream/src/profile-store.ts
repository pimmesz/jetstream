import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Placement } from './layout';
import { writeFileAtomicSync } from './atomic-write';
import { errorMessage } from './errors';

/**
 * Stream Deck's own profile store (ProfilesV3), read and written in place. Importing a
 * .streamDeckProfile always ADDS a profile ("Jetstream Custom copy 2" ...), so a structural edit is
 * written straight into the board the user already has: back it up, quit the app, rewrite only the
 * changed keys on its current page, relaunch. The format is undocumented, so every write is gated
 * on the exact shape seen here and refuses anything else.
 */

/** One key as Stream Deck stores it. Unknown fields are carried through untouched. */
export interface StoredAction {
  ActionID?: unknown;
  Name?: unknown;
  Plugin?: unknown;
  Settings?: unknown;
  State?: unknown;
  States?: unknown;
  UUID?: unknown;
  [field: string]: unknown;
}

export interface CurrentPage {
  /** The page id, as the profile manifest lists it. */
  pageId: string;
  /** The page's manifest.json, the only file an in-place write touches. */
  manifestPath: string;
  /** `${col},${row}` → the stored key, from the keypad controller. */
  actions: Record<string, StoredAction>;
}

interface PageManifest {
  Controllers?: Array<{ Type?: unknown; Actions?: Record<string, StoredAction> }>;
  [field: string]: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Page directories are stored upper-case while the manifest lists ids lower-case. */
function pageDir(profileDir: string, pageId: string): string | undefined {
  try {
    const want = pageId.toLowerCase();
    const found = readdirSync(join(profileDir, 'Profiles')).find((d) => d.toLowerCase() === want);
    return found ? join(profileDir, 'Profiles', found) : undefined;
  } catch {
    return undefined;
  }
}

/** The page the deck shows for this profile (`Pages.Current`, else the first listed page), or the
 * listed page `pageId` when given; null when the profile is not the Version 3.0 layout this code
 * understands or that page is gone. Never throws. */
export function readCurrentPage(profileDir: string, pageId?: string): CurrentPage | null {
  let top: Record<string, unknown> | undefined;
  try {
    top = asRecord(JSON.parse(readFileSync(join(profileDir, 'manifest.json'), 'utf8')));
  } catch {
    return null;
  }
  if (top?.Version !== '3.0') return null;
  const pages = asRecord(top.Pages);
  const listed = Array.isArray(pages?.Pages) ? pages.Pages.filter((p): p is string => typeof p === 'string') : [];
  const current =
    pageId !== undefined
      ? listed.find((p) => p.toLowerCase() === pageId.toLowerCase())
      : typeof pages?.Current === 'string' && listed.includes(pages.Current)
        ? pages.Current
        : listed[0];
  if (!current) return null;
  const dir = pageDir(profileDir, current);
  if (!dir) return null;
  const manifestPath = join(dir, 'manifest.json');
  let page: PageManifest;
  try {
    page = JSON.parse(readFileSync(manifestPath, 'utf8')) as PageManifest;
  } catch {
    return null;
  }
  const keypad = page.Controllers?.find((c) => c.Type === 'Keypad');
  if (!keypad || !asRecord(keypad.Actions)) return null;
  return { pageId: current, manifestPath, actions: keypad.Actions as Record<string, StoredAction> };
}

/** The title style Stream Deck writes for a plain key, used for keys this code creates. */
const DEFAULT_STATE = {
  FontFamily: '',
  FontSize: 18,
  FontStyle: '',
  FontUnderline: false,
  OutlineThickness: 2,
  ShowTitle: true,
  TitleAlignment: 'middle',
  TitleColor: '#ededff',
};

export interface OverlayOptions {
  /** This plugin's manifest Version, stamped on Jetstream keys this code creates. */
  jetstreamVersion: string;
  newId?: () => string;
}

/**
 * Lay placements over a page's stored keys. A key whose action UUID stays the same keeps its
 * ActionID, title style and state, and only its Settings and Name change. A new key gets a fresh
 * ActionID; a copied third-party key (`placement.source`) keeps its plugin block and states, so a
 * two-state Hue toggle stays two-state. Pure.
 */
export function overlayActions(
  actions: Record<string, StoredAction>,
  placements: Placement[],
  options: OverlayOptions,
): Record<string, StoredAction> {
  const newId = options.newId ?? randomUUID;
  const next: Record<string, StoredAction> = { ...actions };
  for (const p of placements) {
    const coord = `${p.column},${p.row}`;
    const existing = actions[coord];
    if (existing && existing.UUID === p.uuid) {
      next[coord] = { ...existing, Name: p.name, Settings: p.settings };
      continue;
    }
    const plugin = p.uuid.startsWith('gg.pim.jetstream.')
      ? { Name: 'Jetstream', UUID: 'gg.pim.jetstream', Version: options.jetstreamVersion }
      : (p.source?.plugin ?? null); // Stream Deck fills in its own built-in actions
    const states = Array.isArray(p.source?.states) && p.source.states.length > 0 ? p.source.states : [DEFAULT_STATE];
    next[coord] = {
      ActionID: newId(),
      LinkedTitle: false,
      Name: p.name,
      Plugin: plugin,
      Resources: null,
      Settings: p.settings,
      State: 0,
      States: states,
      UUID: p.uuid,
    };
  }
  return next;
}

/** Write the overlaid keys into the page manifest atomically, changing nothing else in the file. */
export function writePageActions(manifestPath: string, actions: Record<string, StoredAction>): void {
  const page = JSON.parse(readFileSync(manifestPath, 'utf8')) as PageManifest;
  const keypad = page.Controllers?.find((c) => c.Type === 'Keypad');
  if (!keypad) throw new Error(`${manifestPath} has no keypad controller; not writing`);
  keypad.Actions = actions;
  writeFileAtomicSync(manifestPath, JSON.stringify(page));
}

/** Copy a profile directory to a timestamped backup, keeping the newest `keep` per profile. */
export function backupProfile(
  profileDir: string,
  backupRoot: string = join(homedir(), '.config', 'jetstream', 'profile-backups'),
  now: Date = new Date(),
  keep = 5,
): string {
  const name = profileDir.split('/').pop() ?? 'profile';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = join(backupRoot, `${name}.${stamp}`);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(profileDir, dest, { recursive: true });
  const old = readdirSync(backupRoot)
    .filter((d) => d.startsWith(`${name}.`))
    .sort()
    .slice(0, -keep);
  for (const d of old) rmSync(join(backupRoot, d), { recursive: true, force: true });
  return dest;
}

export interface AppControl {
  isRunning: () => boolean;
  quit: () => void;
  launch: () => void;
  sleep: (ms: number) => Promise<void>;
}

const BUNDLE_ID = 'com.elgato.StreamDeck';

export const macStreamDeck: AppControl = {
  isRunning: () => spawnSync('pgrep', ['-x', 'Stream Deck']).status === 0,
  quit: () => {
    execFileSync('osascript', ['-e', `quit app id "${BUNDLE_ID}"`], { timeout: 10_000 });
  },
  launch: () => {
    execFileSync('open', ['-b', BUNDLE_ID], { timeout: 10_000 });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type InPlaceResult =
  | { ok: true; backup: string; removed: string[] }
  | {
      ok: false;
      reason: string;
      /** The keys `changedSincePlan` named, when that is why nothing was written. */
      changed?: string[];
    };

/**
 * Write placements into a profile in place: quit Stream Deck (it rewrites its profiles when it quits,
 * so a write while it runs would be lost), re-read the page from disk, check nothing planned changed,
 * back up, overlay, write, relaunch. The app is relaunched on every path once it was quit, so a failure
 * never leaves the deck dark.
 */
export async function writeInPlace(
  profileDir: string,
  placements: Placement[],
  options: OverlayOptions & {
    app?: AppControl;
    backupRoot?: string;
    quitTimeoutMs?: number;
    /** Runs while the app is down (deletions only stick then); returns what it removed. */
    whileQuit?: () => string[];
    /** Exclusive-write lock file (tests point it into a temp dir). */
    lockPath?: string;
    /** The page the edits were planned against. Without it the page current after the quit is used,
     * which may not be the one the user previewed if they switched pages meanwhile. */
    pageId?: string;
    /** Given the page as re-read after the quit (inside the lock), the keys that changed since the plan
     * was made. If it names any, nothing is written. Required, so no caller can drop the check. */
    changedSincePlan: (actions: Record<string, StoredAction>) => string[];
  },
): Promise<InPlaceResult> {
  const app = options.app ?? macStreamDeck;
  if (!readCurrentPage(profileDir, options.pageId)) {
    return { ok: false, reason: 'the profile is not in the Stream Deck 7 format this writer understands' };
  }
  // Two chat windows applying at once would both read the page while Stream Deck is down, and the
  // second rename would silently drop the first one's keys. One writer at a time.
  const lock = options.lockPath ?? join(homedir(), '.config', 'jetstream', 'profile-write.lock');
  const held = takeWriteLock(lock);
  if (!('token' in held)) return { ok: false, reason: held.reason };
  const wasRunning = app.isRunning();
  try {
    if (wasRunning) {
      app.quit();
      const deadline = Date.now() + (options.quitTimeoutMs ?? 20_000);
      while (app.isRunning()) {
        if (Date.now() > deadline) return { ok: false, reason: 'Stream Deck did not quit within 20 seconds' };
        await app.sleep(250);
      }
    }
    // Read and back up AFTER the quit: the app saves its own pending edits on the way out, and the
    // compare and the backup must both see them.
    const page = readCurrentPage(profileDir, options.pageId);
    if (!page) return { ok: false, reason: 'the page you edited is gone or changed shape while Stream Deck quit' };
    // Only now does disk hold every edit Stream Deck kept in memory, so this is where a change shows.
    // Checked before the backup, so a write that is called off never pushes out one of the kept backups.
    const changed = options.changedSincePlan(page.actions);
    if (changed.length > 0) {
      return { ok: false, reason: `these keys changed since the plan was made: ${changed.join(', ')}`, changed };
    }
    const backup = backupProfile(profileDir, options.backupRoot);
    writePageActions(page.manifestPath, overlayActions(page.actions, placements, options));
    return { ok: true, backup, removed: options.whileQuit?.() ?? [] };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  } finally {
    if (wasRunning) {
      try {
        app.launch();
      } catch {
        // The caller tells the user to open Stream Deck; the write itself already succeeded or failed.
      }
    }
    releaseWriteLock(lock, held.token);
  }
}

/** A write takes seconds; a lock older than this was left by a process that died mid-write. */
const STALE_LOCK_MS = 2 * 60_000;

const BUSY = { reason: 'another `jetstream chat` is updating the board right now; try again in a moment' };

/** Take the board lock: this writer's token, or why not. The token makes the release ownership-checked.
 * A stale lock is reported, never taken over: every automatic takeover without an OS lock can let
 * two writers through when several chats race for it, and a crash mid-write is rare enough that one
 * manual delete is the safer price. */
function takeWriteLock(path: string, now = Date.now()): { token: string } | { reason: string } {
  const token = `${process.pid} ${randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token, { flag: 'wx' });
    return { token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { reason: `cannot take the board lock at ${path} (${errorMessage(error)})` };
    }
  }
  try {
    if (now - statSync(path).mtimeMs < STALE_LOCK_MS) return BUSY;
  } catch {
    return BUSY; // released between our create and this check: the next try will get it
  }
  return {
    reason: `a previous \`jetstream chat\` stopped while updating the board and left ${path}; if no other chat is running, delete that file and try again`,
  };
}

/** Remove the lock only while it is still ours. */
function releaseWriteLock(path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
  } catch {
    // already gone
  }
}
