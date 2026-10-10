import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editSlot } from './slot-inspector';
import type { SlotSettings } from './actions/slot';

const html = readFileSync(new URL('../gg.pim.jetstream.sdPlugin/ui/slot.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../gg.pim.jetstream.sdPlugin/ui/slot.js', import.meta.url), 'utf8');

/** Exercise the shipped bridge script with the real validator and a small DOM/host boundary. */
function inspectorUI(initial: SlotSettings = {}) {
  type Field = {
    id: string; value: string; textContent: string; disabled: boolean; hidden: boolean;
    dataset: Record<string, string>; events: Record<string, (event: { preventDefault: () => void }) => void>;
    attributes: Record<string, string>;
    addEventListener: (type: string, callback: Field['events'][string]) => void;
    append: (field: Field) => void; remove: () => void;
    setAttribute: (name: string, value: string) => void; removeAttribute: (name: string) => void; focus: () => void;
  };
  const fields = new Map<string, Field>();
  let focused: string | undefined;
  const field = (id: string): Field => ({
    id, value: '', textContent: '', disabled: true, hidden: false, dataset: {}, events: {}, attributes: {},
    addEventListener(type, callback) { this.events[type] = callback; },
    append(child) { fields.set(child.id, child); },
    remove() { fields.delete(this.id); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { focused = this.id; },
  });
  for (const match of html.matchAll(/id="([^"]+)"/g)) fields.set(match[1]!, field(match[1]!));
  let stored = initial;
  const writes: SlotSettings[] = [];
  const sent: Record<string, unknown>[] = [];
  let shouldReply = true;
  let socket: HostSocket;
  class HostSocket {
    static OPEN = 1;
    readyState = 1;
    onopen = () => {};
    onmessage = (_event: { data: string }) => {};
    constructor() { socket = this; }
    send(raw: string) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.event !== 'sendToPlugin' || !shouldReply) return;
      const { slot, requestId, expect: base, edit } = message.payload;
      const result = slot === 'read' ? { ok: true as const, settings: stored } : editSlot(stored, base, edit);
      if (slot === 'save' && result.ok) { stored = result.settings; writes.push(stored); }
      this.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: {
        ...result, slot: 'result', requestId, actionId: 'key-1',
      } }) });
    }
  }
  let sequence = 0;
  const context = {
    document: { getElementById: (id: string) => fields.get(id), createElement: () => field('') },
    WebSocket: HostSocket, setTimeout, clearTimeout, crypto: { randomUUID: () => `request-${++sequence}` },
  };
  runInNewContext(script, context);
  runInNewContext(`connectElgatoStreamDeckSocket('0', 'pi', 'registerPropertyInspector', '{}', '{"context":"key-1"}')`, context);
  socket!.onopen();
  const get = (id: string) => fields.get(id)!;
  const fire = (id: string, event: string) => get(id).events[event]!({ preventDefault: () => {} });
  const choose = (kind: string) => { get('kind').value = kind; fire('kind', 'change'); };
  return { get, fire, choose, writes, sent, stored: () => stored, focused: () => focused,
    changeBehindForm: (next: SlotSettings) => { stored = next; }, silence: () => { shouldReply = false; } };
}

describe('Slot inspector bridge', () => {
  afterEach(() => vi.useRealTimers());

  it('loads without writes, saves the form explicitly, and cancels unsaved input', () => {
    const ui = inspectorUI();
    expect(ui.writes).toEqual([]);
    ui.choose('app');
    ui.get('target').value = '/Applications/Telegram.app';
    ui.get('label').value = 'Messages';
    expect(ui.writes).toEqual([]);
    ui.fire('slotForm', 'submit');
    expect(ui.stored()).toEqual({ kind: 'app', app: '/Applications/Telegram.app', label: 'Messages' });
    expect(ui.get('status').textContent).toBe('Saved.');
    ui.get('label').value = 'Unsaved';
    ui.fire('cancel', 'click');
    expect(ui.get('label').value).toBe('Messages');
    expect(ui.writes).toHaveLength(1);
    expect(ui.sent.some((m) => m.event === 'setSettings')).toBe(false);
  });

  it('keeps a draft on invalid input and lets the user correct it', () => {
    const ui = inspectorUI();
    ui.choose('url');
    ui.get('target').value = 'javascript:alert(1)';
    ui.fire('slotForm', 'submit');
    expect(ui.writes).toEqual([]);
    expect(ui.get('status').textContent).toContain('http');
    expect(ui.get('target').value).toBe('javascript:alert(1)');
    ui.get('target').value = 'https://example.com';
    ui.fire('slotForm', 'submit');
    expect(ui.get('status').textContent).toBe('Saved.');
  });

  it('marks and focuses the field an error is about, and clears it once the save works', () => {
    const ui = inspectorUI();
    ui.choose('url');
    ui.get('target').value = 'javascript:alert(1)';
    ui.fire('slotForm', 'submit');
    expect(ui.get('target').attributes).toMatchObject({ 'aria-invalid': 'true', 'aria-errormessage': 'status' });
    expect(ui.focused()).toBe('target');
    ui.get('target').value = 'https://example.com';
    ui.get('color').value = 'constructor';
    ui.fire('slotForm', 'submit');
    expect(ui.get('target').attributes).toEqual({});
    expect(ui.get('color').attributes).toMatchObject({ 'aria-invalid': 'true' });
    expect(ui.focused()).toBe('color');
    ui.get('color').value = '';
    ui.fire('slotForm', 'submit');
    expect(ui.get('status').textContent).toBe('Saved.');
    expect(ui.get('color').attributes).toEqual({});
  });

  it('links the kind hint to the kind select', () => {
    expect(html).toMatch(/<select id="kind" aria-describedby="kindHint">/);
  });

  it('plain words for the app hint and a lost connection', () => {
    const ui = inspectorUI({ kind: 'app', app: '/Applications/Telegram.app' });
    expect(ui.get('kindHint').textContent).toBe('Enter the full path, such as /Applications/Telegram.app. A script or program only runs when run keys are turned on.');
    expect(script).toContain("'Lost the connection to Jetstream. Click another key, then click this key again.'");
  });

  it('refuses a stale save and Cancel reloads the newer settings', () => {
    const ui = inspectorUI({ kind: 'url', url: 'https://example.com' });
    ui.get('label').value = 'My draft';
    ui.changeBehindForm({ kind: 'url', url: 'https://example.com', label: 'Chat edit' });
    ui.fire('slotForm', 'submit');
    expect(ui.writes).toEqual([]);
    expect(ui.get('status').textContent).toContain('changed');
    expect(ui.get('label').value).toBe('My draft');
    ui.fire('cancel', 'click');
    expect(ui.get('label').value).toBe('Chat edit');
  });

  it.each(['run', 'stopall'] as const)('shows %s without allowing a save', (kind) => {
    const ui = inspectorUI({ kind, command: 'echo', args: ['hello'] });
    expect(ui.get('fields').disabled).toBe(true);
    expect(ui.get('save').disabled).toBe(true);
    expect(ui.get('kindHint').textContent).toContain("You can't change this key here");
    ui.fire('slotForm', 'submit');
    expect(ui.writes).toEqual([]);
  });

  it('tells only app keys that the app icon hides Label and Colour', () => {
    expect(html).toMatch(/id="appIconHint"[^>]*>[^<]*icon[^<]*Label and Colour/);
    const ui = inspectorUI({ kind: 'app', app: '/Applications/Telegram.app' });
    expect(ui.get('appIconHint').hidden).toBe(false);
    for (const kind of ['url', 'project', 'empty']) {
      ui.choose(kind);
      expect(ui.get('appIconHint').hidden).toBe(true);
    }
    ui.choose('app');
    expect(ui.get('appIconHint').hidden).toBe(false);
  });

  it('preserves Codex usage settings through the actual form script', () => {
    const ui = inspectorUI({ kind: 'usage', provider: 'codex', icon: 'X' });
    ui.get('color').value = 'blue';
    ui.fire('slotForm', 'submit');
    expect(ui.stored()).toEqual({ kind: 'usage', provider: 'codex', icon: 'X', color: '#0091ff' });
  });

  it('requires a reload after an unconfirmed request instead of blindly retrying', () => {
    vi.useFakeTimers();
    const ui = inspectorUI();
    ui.silence();
    ui.choose('project');
    ui.get('target').value = '/Users/me/repo';
    ui.fire('slotForm', 'submit');
    expect(ui.get('save').disabled).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(ui.get('status').textContent).toBe('No answer from Jetstream. Choose Cancel to load the key again, then check it.');
    expect(ui.get('save').disabled).toBe(true);
    expect(ui.get('cancel').disabled).toBe(false);
  });
});
