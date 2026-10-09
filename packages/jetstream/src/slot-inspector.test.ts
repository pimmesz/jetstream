import { describe, expect, it } from 'vitest';
import { editSlot } from './slot-inspector';
import type { SlotSettings } from './actions/slot';

const form = (kind: string, target = '', label = '', color = '') => ({ kind, target, label, color });

describe('editSlot', () => {
  it.each([
    ['app', '/Applications/Telegram.app', { app: '/Applications/Telegram.app' }],
    ['url', 'https://example.com', { url: 'https://example.com' }],
    ['project', '/Users/me/project', { path: '/Users/me/project' }],
  ])('creates a %s slot from an empty key', (kind, target, fields) => {
    expect(editSlot({}, {}, form(kind, target, 'My key', 'blue'))).toEqual({
      ok: true, settings: { kind, ...fields, label: 'My key', color: '#0091ff' },
    });
  });

  it('preserves the provider, icon, subtitle and unknown settings during cosmetic edits', () => {
    const current = { kind: 'usage' as const, provider: 'codex' as const, icon: 'X', sub: 'limit', future: { keep: true } };
    expect(editSlot(current, current, form('usage', '', 'Codex', '#abc'))).toEqual({
      ok: true, settings: { ...current, label: 'Codex', color: '#aabbcc' },
    });
  });

  it('removes old targets when changing kind but keeps unrelated settings', () => {
    const current = { kind: 'project' as const, path: '/old', name: 'Old', icon: 'X', sub: 'hello' };
    expect(editSlot(current, current, form('url', 'https://example.com'))).toEqual({
      ok: true, settings: { kind: 'url', url: 'https://example.com', icon: 'X', sub: 'hello' },
    });
  });

  it('drops the hidden project name when the path changes and keeps it when the path stays', () => {
    const current = { kind: 'project' as const, path: '/Users/me/api', name: 'api', icon: 'X' };
    expect(editSlot(current, current, form('project', '/Users/me/web'))).toEqual({
      ok: true, settings: { kind: 'project', path: '/Users/me/web', icon: 'X' },
    });
    expect(editSlot(current, current, form('project', current.path, 'API'))).toEqual({
      ok: true, settings: { ...current, label: 'API' },
    });
  });

  it('lets the user repair a basic slot with a missing target', () => {
    const current = { kind: 'app' as const };
    expect(editSlot(current, current, form('app', '/Applications/Telegram.app'))).toEqual({
      ok: true, settings: { kind: 'app', app: '/Applications/Telegram.app' },
    });
  });

  it('clears explicit overrides and makes an empty key blank', () => {
    const current = { kind: 'url' as const, url: 'https://example.com', label: 'Old', color: '#ffffff', icon: 'X' };
    expect(editSlot(current, current, form('url', current.url))).toEqual({
      ok: true, settings: { kind: 'url', url: current.url, icon: 'X' },
    });
    expect(editSlot(current, current, form('empty'))).toEqual({ ok: true, settings: { kind: 'empty' } });
  });

  it.each(['run', 'stopall'])('keeps existing %s slots entirely read-only', (kind) => {
    const current = { kind, command: 'echo' } as SlotSettings;
    expect(editSlot(current, current, form('empty')).ok).toBe(false);
    expect(editSlot(current, current, form(kind, '', 'New')).ok).toBe(false);
  });

  it.each(['run', 'stopall', 'usage', 'unknown'])('does not create a %s slot', (kind) => {
    expect(editSlot({}, {}, form(kind)).ok).toBe(false);
  });

  it.each([
    form('url', 'javascript:alert(1)'), form('app', '-a'), form('project', '~/repo'),
    form('url', 'https://example.com', '', 'constructor'), form('empty', '', '', '#xyz'),
    { ...form('empty'), command: 'echo' }, { ...form('empty'), label: 12 },
  ])('rejects an invalid form without changing the original settings', (edit) => {
    const current = Object.freeze({ kind: 'empty' as const });
    expect(editSlot(current, current, edit).ok).toBe(false);
    expect(current).toEqual({ kind: 'empty' });
  });

  it('requires a snapshot and refuses a stale one, including changes to hidden fields', () => {
    expect(editSlot({}, undefined, form('empty')).ok).toBe(false);
    expect(editSlot({}, [], form('empty')).ok).toBe(false);
    const current = { kind: 'usage' as const, provider: 'codex' as const };
    expect(editSlot(current, { kind: 'usage' }, form('usage')).ok).toBe(false);
  });
});
