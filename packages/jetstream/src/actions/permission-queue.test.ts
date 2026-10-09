import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionDecisionJson } from '@pimmesz/jetstream-status';
import { ARM_HOLD_MS, PermissionKey } from './permission';
import { FACE_SUMMARY_MAX, permissions } from '../permissions';
import { board } from '../state';
import { forgetAllPainted } from '../paint';

// The real queue and a real renderAll: the id a press answers is the one the paint put on the face.
const SESSION = 'perm-queue-test';

const req = (command: string, cwd = '/work/falcon/src') => ({
  hook_event_name: 'PermissionRequest',
  session_id: SESSION,
  cwd,
  tool_name: 'Bash',
  tool_input: { command },
});

function fakeKey(decision: 'allow' | 'deny' = 'allow') {
  return {
    id: `key-${decision}`,
    isKey: () => true,
    getSettings: vi.fn(async () => ({ decision })),
    setTitle: vi.fn(async () => {}),
    setImage: vi.fn(async (_image: string) => {}),
    showOk: vi.fn(async () => {}),
    showAlert: vi.fn(async () => {}),
  };
}
type Key = ReturnType<typeof fakeKey>;

function mount(keys: Key[]): PermissionKey {
  const permissionKey = new PermissionKey();
  Object.defineProperty(permissionKey, 'actions', { value: keys, configurable: true });
  return permissionKey;
}
const down = (k: PermissionKey, key: Key, decision: 'allow' | 'deny' = 'allow'): void =>
  k.onKeyDown({ action: key, payload: { settings: { decision } } } as unknown as Parameters<PermissionKey['onKeyDown']>[0]);
const up = (k: PermissionKey, key: Key, decision: 'allow' | 'deny' = 'allow'): Promise<void> =>
  k.onKeyUp({ action: key, payload: { settings: { decision } } } as unknown as Parameters<PermissionKey['onKeyUp']>[0]);
const lastFace = (key: Key): string => decodeURIComponent(key.setImage.mock.calls.at(-1)?.[0] ?? '');

describe('PermissionKey against the real permission queue', () => {
  beforeEach(() => {
    // The real queue checks for a deck stop under HOME on every request: keep it off the real one.
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'js-perm-queue-')));
    vi.useFakeTimers();
    forgetAllPainted();
    board.seed([{ id: 'falcon', name: 'Falcon', path: '/work/falcon' }]);
  });
  afterEach(() => {
    permissions.forgetSession(SESSION); // drops held prompts and armed rules between tests
    board.seed([]);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('a tap answers the request renderAll painted', async () => {
    const answer = permissions.request(req('npm test'));
    const key = fakeKey();
    const k = mount([key]);
    await k.renderAll();
    down(k, key);
    await up(k, key);
    expect(permissions.count()).toBe(0);
    expect(await answer).toBe(permissionDecisionJson('allow'));
    expect(key.showAlert).not.toHaveBeenCalled();
  });

  it('a press while the first paint is still uploading alerts and leaves the request pending', async () => {
    let answered = false;
    void permissions.request(req('npm test')).then(() => (answered = true));
    const key = fakeKey();
    let finishPaint: () => void = () => {};
    key.setImage.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPaint = resolve)));
    const k = mount([key]);
    const painting = k.renderAll();
    await vi.waitFor(() => expect(key.setImage).toHaveBeenCalledTimes(1));
    down(k, key);
    await up(k, key);
    expect(key.showAlert).toHaveBeenCalledTimes(1);
    expect(permissions.count()).toBe(1);
    expect(answered).toBe(false);
    finishPaint();
    await painting;
  });

  it('the face names the project the prompt came from, or its folder when no project matches', async () => {
    const key = fakeKey();
    const k = mount([key]);
    void permissions.request(req('npm test'));
    await k.renderAll();
    expect(lastFace(key)).toContain('>Falcon<');
    expect(lastFace(key)).toContain('Bash: npm test');
    permissions.forgetSession(SESSION);
    void permissions.request(req('npm test', '/work/widget'));
    await k.renderAll();
    expect(lastFace(key)).toContain('>widget<');
  });

  it('marks a command the face cuts short with a corner *, and not one that fits', async () => {
    const key = fakeKey();
    const k = mount([key]);
    void permissions.request(req('npm test'));
    await k.renderAll();
    expect(lastFace(key)).not.toContain('>*<');
    permissions.forgetSession(SESSION);
    void permissions.request(req('npm run build --workspaces --if-present'));
    await k.renderAll();
    expect(lastFace(key)).toContain('>*<');
  });

  it('marks a 24-character summary too: at 14px its tail runs off the 144px key', async () => {
    const key = fakeKey();
    const k = mount([key]);
    void permissions.request(req('rm -rf MyWebApp/ ~'));
    await k.renderAll();
    expect(lastFace(key)).toContain('>*<');
  });

  it('marks a short summary of wide characters: they draw about twice as wide', async () => {
    const key = fakeKey();
    const k = mount([key]);
    const command = 'rm 临时测试文件夹/*';
    expect(`Bash: ${command}`.length).toBeLessThanOrEqual(FACE_SUMMARY_MAX);
    void permissions.request(req(command));
    await k.renderAll();
    expect(lastFace(key)).toContain('>*<');
  });

  it('a queue of two puts the count on the top line and leaves the summary its whole budget', async () => {
    const command = 'npm run lint';
    expect(`Bash: ${command}`.length).toBe(FACE_SUMMARY_MAX);
    void permissions.request(req(command));
    void permissions.request(req('npm test'));
    const key = fakeKey();
    const k = mount([key]);
    await k.renderAll();
    expect(lastFace(key)).toContain('>(+1) Falcon<');
    expect(lastFace(key)).toContain(`>Bash: ${command}<`);
    expect(lastFace(key)).not.toContain('>*<');
  });

  it('past ARM_HOLD_MS the held APPROVE key warns "auto-allow Bash?", and the release arms', async () => {
    const answer = permissions.request(req('npm test'));
    const key = fakeKey();
    const k = mount([key]);
    await k.renderAll();
    down(k, key);
    await vi.advanceTimersByTimeAsync(ARM_HOLD_MS - 1);
    expect(lastFace(key)).not.toContain('>auto-allow<');
    await vi.advanceTimersByTimeAsync(1);
    expect(lastFace(key)).toContain('>auto-allow<');
    expect(lastFace(key)).toContain('>Bash?<');
    await up(k, key);
    expect(await answer).toBe(permissionDecisionJson('allow'));
    expect(permissions.allowRuleCount()).toBe(1);
    expect(key.showOk).toHaveBeenCalled();
    await vi.waitFor(() => expect(lastFace(key)).toContain('auto-allow: 1')); // the idle face replaces the warning
  });

  it('the hold warning shows "auto-allow" and the whole name of even the longest tools, uncut', async () => {
    for (const tool of ['NotebookEdit', 'WebSearch', 'WebFetch', 'MultiEdit']) {
      expect(`${tool}?`.length).toBeLessThanOrEqual(FACE_SUMMARY_MAX); // the sub line's budget
      void permissions.request({ ...req(''), tool_name: tool, tool_input: { file_path: '/work/falcon/a.ipynb' } });
      const key = fakeKey();
      const k = mount([key]);
      await k.renderAll();
      down(k, key);
      await vi.advanceTimersByTimeAsync(ARM_HOLD_MS);
      // Whole text between the tags: a line over its budget would end in an ellipsis instead.
      expect(lastFace(key), tool).toContain('>auto-allow<');
      expect(lastFace(key), tool).toContain(`>${tool}?<`);
      await up(k, key);
      permissions.forgetSession(SESSION);
    }
  });

  it('a held compound command says why it cannot be armed, and the release arms nothing', async () => {
    let answered = false;
    void permissions.request(req('ls | wc -l')).then(() => (answered = true));
    const key = fakeKey();
    const k = mount([key]);
    await k.renderAll();
    down(k, key);
    await vi.advanceTimersByTimeAsync(ARM_HOLD_MS);
    expect(lastFace(key)).toContain('>chained: tap only<'); // whole: it fits the face budget
    await up(k, key);
    expect(key.showAlert).toHaveBeenCalledTimes(1);
    expect(permissions.allowRuleCount()).toBe(0);
    expect(permissions.count()).toBe(1);
    expect(answered).toBe(false);
    await vi.waitFor(() => expect(lastFace(key)).toContain('Bash: ls | wc -l')); // the warning is painted over
  });

  it('a permissions emit during the hold leaves the "auto-allow" warning on the held key', async () => {
    const answer = permissions.request(req('npm test'));
    const key = fakeKey();
    const deny = fakeKey('deny');
    const k = mount([key, deny]);
    await k.renderAll();
    down(k, key);
    await vi.advanceTimersByTimeAsync(ARM_HOLD_MS);
    expect(lastFace(key)).toContain('>auto-allow<');
    void permissions.request(req('npm run lint')); // another session asks while the key is held
    await k.renderAll();
    expect(lastFace(key)).toContain('>auto-allow<');
    expect(lastFace(key)).toContain('>Bash?<');
    expect(lastFace(deny)).toContain('>(+1) Falcon<'); // the key nobody holds still repaints
    await up(k, key);
    expect(await answer).toBe(permissionDecisionJson('allow'));
  });

  it('a DENY press while APPROVE is held answers the request DENY shows, and the release approves nothing', async () => {
    void permissions.request(req('npm test'));
    const second = permissions.request(req('npm run lint'));
    let isThirdAnswered = false;
    void permissions.request(req('npm run build')).then(() => (isThirdAnswered = true));
    const approve = fakeKey();
    const deny = fakeKey('deny');
    const k = mount([approve, deny]);
    await k.renderAll();
    down(k, approve);
    expect(permissions.settle(permissions.head()?.id, 'deny')).toBe(true); // the first times out
    await k.renderAll(); // DENY shows the second; the held APPROVE still shows the first
    down(k, deny, 'deny');
    await up(k, deny, 'deny');
    expect(deny.showAlert).not.toHaveBeenCalled();
    expect(JSON.parse((await second) as string).hookSpecificOutput.decision).toEqual({ behavior: 'deny' });
    await up(k, approve); // answers the first, which is gone: an alert, never the third
    expect(approve.showAlert).toHaveBeenCalledTimes(1);
    expect(permissions.count()).toBe(1);
    expect(isThirdAnswered).toBe(false);
  });

  it('a request answered elsewhere during the hold paints no warning, and the release alerts', async () => {
    void permissions.request(req('npm test'));
    const key = fakeKey();
    const k = mount([key]);
    await k.renderAll();
    down(k, key);
    expect(permissions.settle(permissions.head()?.id, 'deny')).toBe(true); // e.g. a second deck
    await k.renderAll();
    await vi.advanceTimersByTimeAsync(ARM_HOLD_MS + 1); // a throw in the hold timer rejects here
    const faces = key.setImage.mock.calls.map(([image]) => decodeURIComponent(image));
    expect(faces.some((face) => face.includes('auto-allow'))).toBe(false);
    await up(k, key);
    expect(key.showAlert).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(lastFace(key)).toContain('no request'));
  });

  it('a press right after a held release cannot answer a request the held key never showed', async () => {
    void permissions.request(req('npm test'));
    let isSecondAnswered = false;
    void permissions.request(req('npm run lint')).then(() => (isSecondAnswered = true));
    const key = fakeKey();
    const k = mount([key]);
    await k.renderAll();
    down(k, key);
    expect(permissions.settle(permissions.head()?.id, 'deny')).toBe(true); // the second is head now
    await k.renderAll(); // skips the held key, which still shows the first request
    let finishPaint: () => void = () => {};
    key.setImage.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPaint = resolve)));
    await up(k, key); // the first is gone: alert, then the repaint to the second starts
    await vi.waitFor(() => expect(key.setImage).toHaveBeenCalledTimes(2));
    down(k, key);
    await up(k, key);
    expect(key.showAlert).toHaveBeenCalledTimes(2);
    expect(permissions.count()).toBe(1);
    expect(isSecondAnswered).toBe(false);
    finishPaint();
    await vi.waitFor(() => expect(lastFace(key)).toContain('Bash: npm run lint'));
  });

  it('a key that leaves the deck mid-hold never paints the warning, and the deck catches up', async () => {
    void permissions.request(req('npm test'));
    const second = permissions.request(req('npm run lint'));
    const key = fakeKey();
    const deny = fakeKey('deny');
    const keys = [key, deny];
    const k = mount(keys);
    await k.renderAll();
    down(k, key);
    expect(permissions.settle(permissions.head()?.id, 'deny')).toBe(true);
    await k.renderAll(); // DENY now shows the second request
    keys.splice(0, 1); // the SDK drops the key from `actions` before onWillDisappear runs
    const rendered = vi.spyOn(k, 'renderAll');
    k.onWillDisappear({ action: key } as unknown as Parameters<PermissionKey['onWillDisappear']>[0]);
    await rendered.mock.results[0]?.value;
    await vi.advanceTimersByTimeAsync(ARM_HOLD_MS);
    expect(lastFace(key)).not.toContain('auto-allow');
    down(k, deny, 'deny');
    await up(k, deny, 'deny');
    expect(deny.showAlert).not.toHaveBeenCalled();
    expect(JSON.parse((await second) as string).hookSpecificOutput.decision).toEqual({ behavior: 'deny' });
  });

  it('a key that leaves mid-hold with its request still pending shows that request when it returns', async () => {
    void permissions.request(req('npm test'));
    const key = fakeKey();
    const deny = fakeKey('deny');
    const keys = [key, deny];
    const k = mount(keys);
    await k.renderAll();
    down(k, key);
    keys.splice(0, 1);
    const rendered = vi.spyOn(k, 'renderAll');
    k.onWillDisappear({ action: key } as unknown as Parameters<PermissionKey['onWillDisappear']>[0]);
    await rendered.mock.results[0]?.value;
    await vi.advanceTimersByTimeAsync(ARM_HOLD_MS + 1);
    expect(key.setImage.mock.calls.some(([img]) => decodeURIComponent(img).includes('auto-allow'))).toBe(false);
    keys.unshift(key);
    forgetAllPainted();
    const paintsBefore = key.setImage.mock.calls.length;
    await k.renderAll();
    expect(key.setImage.mock.calls.length).toBeGreaterThan(paintsBefore);
    expect(lastFace(key)).toContain('Bash: npm test');
    expect(permissions.count()).toBe(1);
  });
});
