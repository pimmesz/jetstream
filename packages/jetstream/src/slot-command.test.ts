import { describe, it, expect } from 'vitest';
import { coordToCell, isHttpUrl, parseSlotCommand } from './slot-command';

describe('coordToCell', () => {
  it('inverts a coordinate label (row = letter, col = 1-indexed)', () => {
    expect(coordToCell('a1')).toEqual({ column: 0, row: 0 });
    expect(coordToCell('a8')).toEqual({ column: 7, row: 0 });
    expect(coordToCell('D1')).toEqual({ column: 0, row: 3 });
    expect(coordToCell('b3')).toEqual({ column: 2, row: 1 });
  });
  it('returns null for garbage / a zero column', () => {
    expect(coordToCell('8a')).toBeNull();
    expect(coordToCell('')).toBeNull();
    expect(coordToCell('a0')).toBeNull(); // col 0 → -1
  });
});

describe('isHttpUrl', () => {
  it('allows http(s), blocks other schemes', () => {
    expect(isHttpUrl('http://x.com')).toBe(true);
    expect(isHttpUrl('https://x.com')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('parseSlotCommand', () => {
  it('builds an app command (with optional label)', () => {
    expect(parseSlotCommand({ coord: 'a8', kind: 'app', app: '/Applications/Telegram.app', label: 'TG' })).toEqual({
      coord: 'a8',
      column: 7,
      row: 0,
      settings: { kind: 'app', app: '/Applications/Telegram.app', label: 'TG' },
    });
  });
  it('builds a url command only for http(s)', () => {
    expect(parseSlotCommand({ coord: 'b1', kind: 'url', url: 'https://github.com' })?.settings).toEqual({
      kind: 'url',
      url: 'https://github.com',
    });
    expect(parseSlotCommand({ coord: 'b1', kind: 'url', url: 'file:///etc/passwd' })).toBeNull();
    expect(parseSlotCommand({ coord: 'b1', kind: 'url', url: 'javascript:alert(1)' })).toBeNull();
  });
  it('builds a run command with a string[] argv, rejecting a non-string arg', () => {
    expect(parseSlotCommand({ coord: 'c1', kind: 'run', command: 'code', args: ['~/dev'], cwd: '/repo' })?.settings).toEqual({
      kind: 'run',
      command: 'code',
      args: ['~/dev'],
      cwd: '/repo',
    });
    expect(parseSlotCommand({ coord: 'c1', kind: 'run', command: 'code', args: ['ok', 3] })).toBeNull();
    expect(parseSlotCommand({ coord: 'c1', kind: 'run' })).toBeNull(); // no command
  });
  it('clears to an empty slot', () => {
    expect(parseSlotCommand({ coord: 'a1', kind: 'empty' })?.settings).toEqual({ kind: 'empty' });
  });
  it('builds a project command (path required; name/cosmetics optional)', () => {
    expect(parseSlotCommand({ coord: 'a7', kind: 'project', path: '/dev/loudini', name: 'Loudini' })?.settings).toEqual({
      kind: 'project',
      path: '/dev/loudini',
      name: 'Loudini',
    });
    // no path → rejected: without the validator case, path/name would be stripped and the key bind to nothing
    expect(parseSlotCommand({ coord: 'a7', kind: 'project' })).toBeNull();
  });
  it('folds cosmetic fields into any kind — colour normalized, sub, glyph', () => {
    const s = parseSlotCommand({ coord: 'a8', kind: 'app', app: '/x.app', color: 'red', sub: 'chat', glyph: '🚀' })
      ?.settings;
    expect(s).toMatchObject({ kind: 'app', app: '/x.app', color: '#e5484d', sub: 'chat', glyph: '🚀' });
  });
  it('drops an unknown colour name but keeps the rest', () => {
    expect(parseSlotCommand({ coord: 'a8', kind: 'url', url: 'https://x.com', color: 'mauve' })?.settings).toEqual({
      kind: 'url',
      url: 'https://x.com',
    });
  });
  it('rejects bad coord, unknown kind, missing target, and non-objects', () => {
    expect(parseSlotCommand({ coord: 'zz', kind: 'app', app: '/x' })).toBeNull();
    expect(parseSlotCommand({ coord: 'a1', kind: 'bogus' })).toBeNull();
    expect(parseSlotCommand({ coord: 'a1', kind: 'app' })).toBeNull(); // no app
    expect(parseSlotCommand('nope')).toBeNull();
    expect(parseSlotCommand(null)).toBeNull();
  });
});
