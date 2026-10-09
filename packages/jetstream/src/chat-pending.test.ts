import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessRunning, PENDING_TTL_MS, pendingEditsPath, pendingStore, type PendingEdit } from './chat-pending';
import type { BoardLayout } from './board-layout';
import { DECK_MODELS } from './profile';

const xl = DECK_MODELS.find((d) => d.key === 'xl')!;
const noPage: BoardLayout = { profileName: 'J', profileDir: '/p.sdProfile', deck: xl, keys: new Map(), allUuids: [] };
const pageA: BoardLayout = { ...noPage, pageId: 'a' };
const pageB: BoardLayout = { ...noPage, pageId: 'b' };
const T = 1_700_000_000_000;
/** Pids of a chat that still runs and of one that has quit, told apart by `running`. */
const RUNNING = 202;
const GONE = 101;
const running = (pid: number): boolean => pid === RUNNING;

/** A live edit of the top-row key in `column` to an url, made at `at` by the chat with `pid`. */
const urlEdit = (url: string, at = T, column = 0, pid = GONE): PendingEdit => ({
  placement: { column, row: 0, uuid: 'gg.pim.jetstream.slot', name: 'Slot', settings: { kind: 'url', url } },
  before: [{ kind: 'empty' }],
  at,
  pid,
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-pending-'));
  dirs.push(dir);
  return dir;
}

describe('pendingEditsPath', () => {
  it('lives in ~/.jetstream next to the other runtime state', () => {
    expect(pendingEditsPath('/home/u')).toBe('/home/u/.jetstream/chat-pending.json');
  });
});

describe('isProcessRunning', () => {
  it('is true for a live process, also one owned by another user, and false once it exited', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    expect(isProcessRunning(1)).toBe(true); // init or launchd: EPERM for a normal user
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    expect(exited).toBeGreaterThan(0);
    expect(isProcessRunning(exited!)).toBe(false);
  });
});

describe('pendingStore', () => {
  it('round trips per profile and page, and a save for one page keeps the others', () => {
    const path = join(tempDir(), 'chat-pending.json');
    const store = pendingStore(path, () => T);
    store.save(pageA, new Map([['0,0', urlEdit('https://a.dev')]]));
    store.save(pageB, new Map([['0,0', urlEdit('https://b.dev')]]));
    store.save(pageA, new Map([['1,0', urlEdit('https://a2.dev', T, 1)]]));

    const nextChat = pendingStore(path, () => T);
    expect(nextChat.load(pageA)).toEqual(new Map([['1,0', urlEdit('https://a2.dev', T, 1)]])); // page a's replaced
    expect(nextChat.load(pageB)).toEqual(new Map([['0,0', urlEdit('https://b.dev')]]));
    expect(nextChat.load({ ...pageA, profileDir: '/other.sdProfile' }).size).toBe(0);
    expect(nextChat.load(noPage).size).toBe(0);
  });

  it('does not load an edit a chat that is gone left older than the TTL, and drops it on the next save', () => {
    const path = join(tempDir(), 'chat-pending.json');
    let now = T;
    const earlierChat = pendingStore(path, () => now, running);
    earlierChat.save(pageB, new Map([['0,0', urlEdit('https://old.dev', T)]]));
    earlierChat.save(pageA, new Map([['0,0', urlEdit('https://a.dev', T)]]));

    const store = pendingStore(path, () => now, running);
    now = T + PENDING_TTL_MS - 1;
    expect(store.load(pageA).size).toBe(1);
    now = T + PENDING_TTL_MS;
    expect(store.load(pageA).size).toBe(0);
    expect(store.load(pageB).size).toBe(0);

    store.save(pageA, new Map([['0,0', urlEdit('https://new.dev', now)]]));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { edits: Array<{ pageId: string }> };
    expect(onDisk.edits.map((edit) => edit.pageId)).toEqual(['a']); // page b's stale edit is gone
  });

  it('never expires an edit while the chat that made it runs, not even when another chat saves', () => {
    const path = join(tempDir(), 'chat-pending.json');
    let now = T;
    const runningChat = pendingStore(path, () => now, running);
    runningChat.save(pageA, new Map([['0,0', urlEdit('https://a.dev', T, 0, RUNNING)]]));
    // Another chat, since quit, stored an edit of its own on page b, next to one by the running chat.
    const goneChat = pendingStore(path, () => now, running);
    goneChat.save(pageB, new Map([['0,0', urlEdit('https://b.dev', T)], ['1,0', urlEdit('https://b2.dev', T, 1, RUNNING)]]));

    now = T + PENDING_TTL_MS;
    // A third chat's save, on any page, keeps the running chat's edits and drops only the other one.
    pendingStore(path, () => now, running).save({ ...noPage, pageId: 'c' }, new Map());
    const nextChat = pendingStore(path, () => now, running);
    expect(nextChat.load(pageA)).toEqual(new Map([['0,0', urlEdit('https://a.dev', T, 0, RUNNING)]]));
    expect(nextChat.load(pageB)).toEqual(new Map([['1,0', urlEdit('https://b2.dev', T, 1, RUNNING)]]));
  });

  it('ignores a corrupt file, another version and any malformed edit, and never throws', () => {
    const path = join(tempDir(), 'chat-pending.json');
    const store = pendingStore(path, () => T);
    const good = { profileDir: '/p.sdProfile', pageId: 'a', coord: '0,0', ...urlEdit('https://ok.dev') };

    writeFileSync(path, '{ "version": 1, "edits": [ trunc');
    expect(store.load(pageA).size).toBe(0);
    writeFileSync(path, JSON.stringify({ version: 2, edits: [good] }));
    expect(store.load(pageA).size).toBe(0);
    writeFileSync(path, JSON.stringify({ version: 1, edits: { good } }));
    expect(store.load(pageA).size).toBe(0);

    const malformed = [
      null,
      'edit',
      { ...good, coord: '6,0', placement: { ...good.placement, column: 6, uuid: 'com.elgato.streamdeck.system.text' } },
      { ...good, coord: '1,0' }, // the coord does not match the placement's column and row
      { ...good, coord: '2,0', placement: { ...good.placement, column: 2 }, at: 'now' },
      { ...good, coord: '3,0', placement: { ...good.placement, column: 3 }, before: 'empty' },
      { ...good, coord: '4,0', placement: { ...good.placement, column: 4, settings: ['url'] } },
      { ...good, coord: '5,0', placement: { ...good.placement, column: 5 }, pageId: 7 },
      { ...good, coord: '7,0', placement: { ...good.placement, column: 7 }, pid: 0 }, // would check a process group
      { ...good, coord: '7,1', placement: { ...good.placement, column: 7, row: 1 }, pid: '42' },
    ];
    writeFileSync(path, JSON.stringify({ version: 1, edits: [...malformed, good] }));
    expect(store.load(pageA)).toEqual(new Map([['0,0', urlEdit('https://ok.dev')]]));
  });

  it('writes the file 0600 and leaves no temp file behind', () => {
    const dir = tempDir();
    const path = join(dir, 'chat-pending.json');
    pendingStore(path, () => T).save(pageA, new Map([['0,0', urlEdit('https://a.dev')]]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['chat-pending.json']);
  });

  it('keeps working from memory when the file cannot be written', () => {
    const blocker = join(tempDir(), 'not-a-folder');
    writeFileSync(blocker, 'x'); // a regular file where the folder should be
    const store = pendingStore(join(blocker, 'chat-pending.json'), () => T);
    expect(() => store.save(pageA, new Map([['0,0', urlEdit('https://a.dev')]]))).not.toThrow();
    store.save(pageB, new Map([['0,0', urlEdit('https://b.dev')]]));
    expect(store.load(pageA)).toEqual(new Map([['0,0', urlEdit('https://a.dev')]]));
    expect(store.load(pageB)).toEqual(new Map([['0,0', urlEdit('https://b.dev')]]));
  });

  it('keeps edits in memory only when it has no path', () => {
    const store = pendingStore(null, () => T);
    store.save(pageA, new Map([['0,0', urlEdit('https://a.dev')]]));
    expect(store.load(pageA)).toEqual(new Map([['0,0', urlEdit('https://a.dev')]]));
    expect(pendingStore(null, () => T).load(pageA).size).toBe(0);
  });
});
