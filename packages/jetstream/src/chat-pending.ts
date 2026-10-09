import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write';
import type { BoardLayout } from './board-layout';
import { SLOT } from './chat-apply';
import type { Placement } from './layout';

/** A live edit Stream Deck may not have saved to disk yet. `before` is what disk can show there meanwhile:
 * the settings the key held before each of chat's live edits to it. `at` is when the latest edit went live,
 * and `pid` the chat that made it. */
export interface PendingEdit {
  placement: Placement;
  before: unknown[];
  at: number;
  pid: number;
}

/** Pending live edits per profile and page, shared by every chat so the next one plans against them too. */
export interface PendingStore {
  /** The fresh edits for this board's profile and page, keyed by `${column},${row}`. */
  load: (board: BoardLayout) => Map<string, PendingEdit>;
  /** Replace this board's page's edits, keeping other pages' fresh ones. Never throws. */
  save: (board: BoardLayout, edits: Map<string, PendingEdit>) => void;
}

/** Only clears out edits a chat that is gone left behind: disk evidence is the real forget rule. An edit never
 * expires while the chat that made it still runs, since Stream Deck may hold it unsaved for longer. */
export const PENDING_TTL_MS = 60 * 60_000;

/** Whether a process with this pid exists. EPERM means it does, but belongs to another user. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Disposable runtime state, next to board-state.json and hook-spool.jsonl. */
export function pendingEditsPath(home = homedir()): string {
  return join(home, '.jetstream', 'chat-pending.json');
}

interface StoredEdit extends PendingEdit {
  profileDir: string;
  pageId?: string;
  coord: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One well-formed stored edit, or null. Only a Jetstream slot can have a live edit. */
function toStoredEdit(raw: unknown): StoredEdit | null {
  if (!isRecord(raw) || !isRecord(raw.placement)) return null;
  const { profileDir, pageId, coord, before, at, pid } = raw;
  const { column, row, uuid, name, settings } = raw.placement;
  if (typeof profileDir !== 'string' || (pageId !== undefined && typeof pageId !== 'string')) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(before)) return null;
  // A positive integer only: process.kill(0) or a negative pid would check a whole process group.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (uuid !== SLOT || typeof name !== 'string' || !(settings === null || isRecord(settings))) return null;
  if (typeof column !== 'number' || typeof row !== 'number' || coord !== `${column},${row}`) return null;
  const placement: Placement = { column, row, uuid, name, settings };
  return { profileDir, ...(pageId === undefined ? {} : { pageId }), coord, placement, before, at, pid };
}

/** The stored edits. A missing, corrupt or unknown-version file holds none: the worst case is one false 409. */
function readStored(path: string): StoredEdit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return []; // no file yet, or one this version cannot read
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.edits)) return [];
  return parsed.edits.map(toStoredEdit).filter((edit) => edit !== null);
}

/** A store backed by the file at `path` (written 0600), or by memory alone when `path` is null. */
export function pendingStore(
  path: string | null,
  now: () => number = Date.now,
  isRunning: (pid: number) => boolean = isProcessRunning,
): PendingStore {
  let file = path;
  let memory: StoredEdit[] = [];
  const stored = (): StoredEdit[] => (file === null ? memory : readStored(file));
  const isFresh = (edit: StoredEdit): boolean => isRunning(edit.pid) || now() - edit.at < PENDING_TTL_MS;
  const isOnPage = (edit: StoredEdit, board: BoardLayout): boolean =>
    edit.profileDir === board.profileDir && edit.pageId === board.pageId;
  return {
    load(board) {
      const edits = new Map<string, PendingEdit>();
      for (const edit of stored()) {
        if (!isOnPage(edit, board) || !isFresh(edit)) continue;
        edits.set(edit.coord, { placement: edit.placement, before: edit.before, at: edit.at, pid: edit.pid });
      }
      return edits;
    },
    save(board, edits) {
      // Read again first: another chat may have saved its own page since this one loaded.
      const others = stored().filter((edit) => !isOnPage(edit, board) && isFresh(edit));
      const page = board.pageId === undefined ? {} : { pageId: board.pageId };
      const mine = [...edits].map(([coord, edit]) => ({ profileDir: board.profileDir, ...page, coord, ...edit }));
      memory = [...others, ...mine];
      if (file === null) return;
      try {
        writeFileAtomicSync(file, `${JSON.stringify({ version: 1, edits: memory })}\n`, { mode: 0o600 });
      } catch {
        // Go on from memory: this chat keeps every edit, and only a later chat can miss them (one false 409).
        file = null;
      }
    },
  };
}
