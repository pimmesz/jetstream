import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordToCell, isHttpUrl, isRunTarget, isSafeAppTarget, isScriptTarget, parseSlotCommand } from './slot-command';

describe('isScriptTarget', () => {
  it('flags targets the opener would execute, so an app key cannot bypass allowRunKeys', () => {
    for (const p of ['/Users/me/deploy.command', '/tmp/x.sh', '/a/b.TOOL', 'C:\\x\\run.ps1', 'C:\\x\\go.bat', '/a/b.workflow', 'C:\\Tools\\deploy.js', 'C:\\Tools\\x.wsf']) {
      expect(isScriptTarget(p), p).toBe(true);
    }
    // URL forms the opener decodes are gated whatever they end in; a trailing slash does not hide a script.
    for (const p of ['file:///tmp/deploy%2Ecommand', 'file:///tmp/deploy.command?x', 'x-scheme://run', '/tmp/x.sh/']) {
      expect(isScriptTarget(p), p).toBe(true);
    }
    for (const p of ['/Applications/Telegram.app', '/Users/me/Documents', '/Users/me/report.pdf', 'C:\\Apps\\x.exe', undefined]) {
      expect(isScriptTarget(p), String(p)).toBe(false);
    }
  });
});

describe('isRunTarget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-run-target-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, mode: number): string => {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\necho hi\n');
    chmodSync(path, mode);
    return path;
  };

  it('counts an extensionless executable as a run key: the opener runs it in Terminal', async () => {
    expect(await isRunTarget(file('deploy', 0o755))).toBe(true);
    expect(await isRunTarget(file('owner-only', 0o700))).toBe(true);
    expect(await isRunTarget(file('notes', 0o644))).toBe(false); // a plain file just opens
  });

  it('counts launcher types, also behind a symlink whose own name looks harmless', async () => {
    for (const name of ['x.py', 'x.jar', 'x.fileloc', 'x.inetloc', 'x.webloc']) {
      expect(await isRunTarget(file(name, 0o644)), name).toBe(true);
    }
    const script = file('real.command', 0o644);
    const link = join(dir, 'harmless');
    symlinkSync(script, link);
    expect(await isRunTarget(link)).toBe(true);
  });

  // A Finder alias is a plain 0644 file with any name, which realpath cannot follow, yet `open` runs its target.
  it('counts a Finder alias whatever its name, since Node cannot see where it points', async () => {
    const alias = join(dir, 'Quarterly report');
    writeFileSync(alias, Buffer.from('book\0\0\0\0mark\0\0\0\0', 'latin1'));
    chmodSync(alias, 0o644);
    expect(await isRunTarget(alias)).toBe(true);
  });

  it('leaves folders and .app bundles alone, although a folder always has execute bits', async () => {
    const folder = join(dir, 'Documents');
    const app = join(dir, 'Telegram.app');
    mkdirSync(folder);
    mkdirSync(app);
    expect(await isRunTarget(folder)).toBe(false);
    expect(await isRunTarget(app)).toBe(false);
  });

  it('judges a target that is not on disk by its name alone', async () => {
    expect(await isRunTarget(join(dir, 'missing', 'deploy'))).toBe(false);
    expect(await isRunTarget(join(dir, 'missing', 'deploy.py'))).toBe(true);
    expect(await isRunTarget('/Users/me/Downloads/deploy.command')).toBe(true);
    expect(await isRunTarget(undefined)).toBe(false);
  });
});

describe('isRunTarget on folders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-run-project-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a repo folder even when its name ends like a script', async () => {
    for (const name of ['three.js', 'discord.py', 'dotfiles.sh', 'plain-repo']) {
      mkdirSync(join(dir, name));
      expect(await isRunTarget(join(dir, name)), name).toBe(false);
    }
    const link = join(dir, 'linked-repo.js');
    symlinkSync(join(dir, 'three.js'), link);
    expect(await isRunTarget(`${link}/`)).toBe(false);
  });

  it('gates what would run: an executable file, a script, an Automator workflow folder, a missing script path', async () => {
    const deploy = join(dir, 'deploy');
    writeFileSync(deploy, '#!/bin/sh\necho hi\n');
    chmodSync(deploy, 0o755);
    mkdirSync(join(dir, 'Rename.workflow'));
    expect(await isRunTarget(deploy)).toBe(true);
    expect(await isRunTarget(join(dir, 'Rename.workflow'))).toBe(true);
    // Other spellings of the same workflow folder.
    mkdirSync(join(dir, 'Rename.workflow', 'Contents'));
    symlinkSync(join(dir, 'Rename.workflow'), join(dir, 'my-repo'));
    expect(await isRunTarget(join(dir, 'my-repo'))).toBe(true);
    expect(await isRunTarget(`${join(dir, 'Rename.workflow')}/.`)).toBe(true);
    expect(await isRunTarget(join(dir, 'Rename.workflow', 'Contents', '..'))).toBe(true);
    expect(await isRunTarget(join(dir, 'missing', 'run.sh'))).toBe(true);
    expect(await isRunTarget(join(dir, 'missing', 'repo'))).toBe(false);
  });
});

describe('isSafeAppTarget', () => {
  it('rejects only empty targets and opener flags, so apps, files and folders all open', () => {
    expect(isSafeAppTarget('/Applications/Telegram.app')).toBe(true);
    expect(isSafeAppTarget('/Users/me/Documents')).toBe(true); // native Open migrates folders through here
    expect(isSafeAppTarget('/Users/me/report.pdf')).toBe(true);
    expect(isSafeAppTarget('C:\\Apps\\x.exe')).toBe(true);
    expect(isSafeAppTarget('-a')).toBe(false); // never let the opener parse the target as a flag
    expect(isSafeAppTarget('')).toBe(false);
    // On Windows, explorer treats a leading '/' as a switch (/select, /root), so reject it there.
    expect(isSafeAppTarget('/select,C:\\secret', 'win32')).toBe(false);
    expect(isSafeAppTarget('C:\\Apps\\x.exe', 'win32')).toBe(true);
  });
  it('is wired into parseSlotCommand — a flag-like app on a valid coordinate is rejected', () => {
    expect(parseSlotCommand({ coord: 'a8', kind: 'app', app: '-a' })).toBeNull();
    expect(parseSlotCommand({ coord: 'a8', kind: 'app', app: '/Applications/Telegram.app' })).not.toBeNull();
  });
});

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
  it('accepts the logo kind (live brand key placement)', () => {
    expect(parseSlotCommand({ coord: 'a8', kind: 'logo' })).toMatchObject({
      settings: { kind: 'logo' },
    });
  });

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

describe('parseSlotCommand usage kind', () => {
  it('keeps provider codex, defaults to Claude, and drops any other provider value', () => {
    expect(parseSlotCommand({ coord: 'a1', kind: 'usage', provider: 'codex' })?.settings).toEqual({ kind: 'usage', provider: 'codex' });
    expect(parseSlotCommand({ coord: 'a1', kind: 'usage' })?.settings).toEqual({ kind: 'usage' });
    expect(parseSlotCommand({ coord: 'a1', kind: 'usage', provider: 'evil' })?.settings).toEqual({ kind: 'usage' });
  });
});
