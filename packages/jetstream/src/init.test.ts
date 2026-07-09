import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallResult } from './hooks-install';
import {
  expandHome,
  parseSelection,
  renderProjectsJson,
  runInit,
  scanForGitRepos,
  slugId,
} from './init';
import { parseProjectsConfig, parseSettingsPreset } from './projects-config';

const COMMANDS = {
  status: '"node" "/plugin/bin/status-hook.js"',
  permission: '"node" "/plugin/bin/permission-hook.js"',
  usage: '"node" "/plugin/bin/usage-hook.js"',
  toolDetail: false,
};

/** Scripted io: `ask` pops answers in order (missing → ''), `say` collects output. */
const makeIo = (answers: string[]) => {
  const said: string[] = [];
  return {
    io: {
      ask: async (q: string) => {
        said.push(q); // questions land in the transcript too, for order assertions
        return answers.shift() ?? '';
      },
      say: (line: string) => {
        said.push(line);
      },
    },
    said,
  };
};

const okInstall = vi.fn(
  async (): Promise<InstallResult> => ({ changed: true, settingsPath: '/home/u/.claude/settings.json' }),
);

const tmpDirs: string[] = [];
// realpath'd so assertions survive init's path canonicalization (macOS mkdtemp
// hands out /var/folders/…, whose realpath is /private/var/…).
const makeTmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-init-')));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.clearAllMocks();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A fake repo root: a dir containing a `.git` dir. */
const makeRepo = (parent: string, name: string): string => {
  const repo = join(parent, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
};

describe('runInit', () => {
  it('happy path: manual projects + settings answers → parseable projects.json + hooks', async () => {
    const work = makeTmp();
    const repoA = makeRepo(work, 'falcon');
    const repoB = makeRepo(work, 'hawk');
    const configPath = join(makeTmp(), 'jetstream', 'projects.json');
    const { io } = makeIo([
      '', // no scan
      repoA, // add falcon…
      '', // …keep default name
      repoB, // add hawk…
      'Hawk Prod', // …custom name
      '', // finish projects
      'y', // high-contrast theme
      '90', // escalate 90 (non-default)
      '', // long-press: keep default
      '60', // usage refresh: equals the default → must NOT be written
    ]);

    const code = await runInit({ io: io, commands: COMMANDS, configPath, install: okInstall });

    expect(code).toBe(0);
    const raw = readFileSync(configPath, 'utf8');
    // The file must round-trip through the SAME parsers the plugin uses at startup.
    const projects = parseProjectsConfig(raw);
    expect(projects).toEqual([
      { id: 'falcon', name: 'falcon', path: repoA },
      { id: 'hawk-prod', name: 'Hawk Prod', path: repoB },
    ]);
    expect(parseSettingsPreset(raw)).toEqual({ theme: 'highContrast', escalateAfterSec: 90 });
    expect(okInstall).toHaveBeenCalledWith({ commands: COMMANDS });
  });

  it('scan flow: lists depth-1 git repos, a numeric pick adds only those', async () => {
    const parent = makeTmp();
    makeRepo(parent, 'alpha');
    const beta = makeRepo(parent, 'beta');
    mkdirSync(join(parent, 'not-a-repo')); // no .git → never offered
    const configPath = join(makeTmp(), 'projects.json');
    const { io, said } = makeIo([
      parent, // scan here
      '2', // pick beta only (sorted: alpha=1, beta=2)
      '', // no manual adds
      '', // theme default
      '', // escalate default
      '', // long-press default
      '', // refresh default
    ]);

    const code = await runInit({ io, commands: COMMANDS, configPath, install: okInstall });

    expect(code).toBe(0);
    const raw = readFileSync(configPath, 'utf8');
    expect(parseProjectsConfig(raw)).toEqual([{ id: 'beta', name: 'beta', path: beta }]);
    // All-default settings → no settings block at all (a clean file documents only choices).
    expect(raw).not.toContain('"settings"');
    expect(said.join('\n')).toContain('1. '); // the scan listed the repos it found
    expect(said.join('\n')).not.toContain('not-a-repo'); // …and never the .git-less dir
  });

  it('never clobbers an existing projects.json without an explicit yes (hooks still run)', async () => {
    const cfgDir = makeTmp();
    const configPath = join(cfgDir, 'projects.json');
    const existing = '{ "projects": [{ "id": "keep", "name": "Keep", "path": "/keep" }] }\n';
    writeFileSync(configPath, existing);
    const { io } = makeIo([
      '', // no scan
      '', // no manual adds
      '', // theme
      '', // escalate
      '', // long-press
      '', // refresh
      'n', // do NOT overwrite
    ]);

    const code = await runInit({ io, commands: COMMANDS, configPath, install: okInstall });

    expect(code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(existing); // byte-identical
    expect(okInstall).toHaveBeenCalledTimes(1); // hooks are independent of the file decision
  });

  it('a nonexistent path is only added after an explicit yes', async () => {
    const configPath = join(makeTmp(), 'projects.json');
    const ghost = join(makeTmp(), 'gone');
    rmSync(ghost, { recursive: true, force: true });
    const { io } = makeIo([
      '', // no scan
      ghost, // path that doesn't exist…
      'n', // …declined
      ghost, // again…
      'y', // …accepted this time
      'Ghost', // name
      '', // finish
      '', // theme
      '', // escalate
      '', // long-press
      '', // refresh
    ]);

    const code = await runInit({ io, commands: COMMANDS, configPath, install: okInstall });

    expect(code).toBe(0);
    expect(parseProjectsConfig(readFileSync(configPath, 'utf8'))).toEqual([
      { id: 'ghost', name: 'Ghost', path: ghost },
    ]);
  });

  it('overwrites an existing projects.json after an explicit yes', async () => {
    const cfgDir = makeTmp();
    const configPath = join(cfgDir, 'projects.json');
    writeFileSync(configPath, '{ "projects": [{ "id": "old", "name": "Old", "path": "/old" }] }\n');
    const work = makeTmp();
    const repo = makeRepo(work, 'fresh');
    const { io } = makeIo([
      '', // no scan
      repo, // one new project
      '', // default name
      '', // finish
      '', // theme
      '', // escalate
      '', // long-press
      '', // refresh
      'y', // overwrite the existing file
    ]);

    const code = await runInit({ io, commands: COMMANDS, configPath, install: okInstall });

    expect(code).toBe(0);
    expect(parseProjectsConfig(readFileSync(configPath, 'utf8'))).toEqual([
      { id: 'fresh', name: 'fresh', path: repo },
    ]);
  });

  it('a root path gets a usable fallback name instead of aborting the wizard', async () => {
    const configPath = join(makeTmp(), 'projects.json');
    const { io } = makeIo([
      '', // no scan
      '/', // filesystem root: basename('') — needs the fallback
      '', // accept the fallback name at `Name [project]:`
      '', // finish
      '', // theme
      '', // escalate
      '', // long-press
      '', // refresh
    ]);

    const code = await runInit({ io, commands: COMMANDS, configPath, install: okInstall });

    expect(code).toBe(0); // never the round-trip "Internal error" path
    expect(parseProjectsConfig(readFileSync(configPath, 'utf8'))).toEqual([
      { id: 'project', name: 'project', path: '/' },
    ]);
  });

  it('deck pick → writes Jetstream.streamDeckProfile into cwd and offers to open it', async () => {
    const cwd = makeTmp();
    const repo = makeRepo(cwd, 'falcon');
    const configPath = join(makeTmp(), 'projects.json');
    const opened: string[] = [];
    const { io, said } = makeIo([
      '', // no scan
      repo, // one project
      '', // default name
      '', // finish
      '', // theme
      '', // escalate
      '', // long-press
      '', // refresh
      '3', // deck: XL
      'y', // open it now
    ]);

    const code = await runInit({
      io,
      commands: COMMANDS,
      configPath,
      install: okInstall,
      cwd,
      openFile: (path) => opened.push(path),
    });

    expect(code).toBe(0);
    const artifact = join(cwd, 'Jetstream.streamDeckProfile');
    const bytes = readFileSync(artifact);
    expect(bytes.subarray(0, 2).toString()).toBe('PK'); // a real zip
    expect(opened).toEqual([artifact]);
    expect(said.join('\n')).toContain('1 project key');
    expect(said.join('\n')).toContain('double-click'); // next steps point at the import
  });

  it('declining the open prompt writes the artifact but never launches the opener', async () => {
    const cwd = makeTmp();
    const configPath = join(makeTmp(), 'projects.json');
    const opened: string[] = [];
    const { io, said } = makeIo([
      '', // no scan
      '', // no projects
      '', // theme
      '', // escalate
      '', // long-press
      '', // refresh
      '3', // deck: XL
      'n', // do NOT open
    ]);

    const code = await runInit({
      io,
      commands: COMMANDS,
      configPath,
      install: okInstall,
      cwd,
      openFile: (path) => opened.push(path),
    });

    expect(code).toBe(0);
    expect(readFileSync(join(cwd, 'Jetstream.streamDeckProfile')).subarray(0, 2).toString()).toBe('PK');
    expect(opened).toEqual([]); // consent guard: no press, no launch
    expect(said.join('\n')).toContain('double-click');
  });

  it('an invalid deck answer skips the layout instead of silently building the wrong model', async () => {
    const cwd = makeTmp();
    const configPath = join(makeTmp(), 'projects.json');
    const opened: string[] = [];
    const { io, said } = makeIo(['', '', '', '', '', '', '9']); // deck "9" → no match

    const code = await runInit({
      io,
      commands: COMMANDS,
      configPath,
      install: okInstall,
      cwd,
      openFile: (path) => opened.push(path),
    });

    expect(code).toBe(0);
    expect(() => readFileSync(join(cwd, 'Jetstream.streamDeckProfile'))).toThrow();
    expect(opened).toEqual([]);
    expect(said.join('\n')).toContain('no deck matches "9"');
    expect(said.join('\n')).toContain('Drag a Fleet key'); // fallback next steps
  });

  it('skipping the deck question leaves no profile artifact and keeps the drag-keys steps', async () => {
    const cwd = makeTmp();
    const configPath = join(makeTmp(), 'projects.json');
    const opened: string[] = [];
    const { io, said } = makeIo(['', '', '', '', '', '', '']); // all defaults incl. deck skip

    const code = await runInit({
      io,
      commands: COMMANDS,
      configPath,
      install: okInstall,
      cwd,
      openFile: (path) => opened.push(path),
    });

    expect(code).toBe(0);
    expect(() => readFileSync(join(cwd, 'Jetstream.streamDeckProfile'))).toThrow();
    expect(opened).toEqual([]);
    expect(said.join('\n')).toContain('Drag a Fleet key');
  });

  it('a failing hook install → exit 1 with the error surfaced (file already written)', async () => {
    const configPath = join(makeTmp(), 'projects.json');
    const install = vi.fn(async (): Promise<InstallResult> => {
      throw new Error('settings.json is not valid JSON');
    });
    const { io, said } = makeIo(['', '', '', '', '', '']);

    const code = await runInit({ io, commands: COMMANDS, configPath, install });

    expect(code).toBe(1);
    expect(said.join('\n')).toContain('settings.json is not valid JSON');
  });
});

describe('init helpers', () => {
  it('slugId: lowercases, collapses junk, uniquifies', () => {
    const taken = new Set<string>();
    expect(slugId('Hawk Prod', taken)).toBe('hawk-prod');
    expect(slugId('hawk prod', taken)).toBe('hawk-prod-2');
    expect(slugId('***', taken)).toBe('project');
  });

  it('parseSelection: empty/all → everything; junk and out-of-range dropped; dedup', () => {
    expect(parseSelection('', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('all', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('2, 2, 9, x, 1', 3)).toEqual([1, 0]);
    // Range syntax is NOT supported — "1-3" must be dropped, never misread as 1.
    expect(parseSelection('1-3', 3)).toEqual([]);
  });

  it('expandHome: ~ and ~/x expand, anything else untouched', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/repos', '/home/u')).toBe('/home/u/repos');
    expect(expandHome('/abs/path', '/home/u')).toBe('/abs/path');
  });

  it('scanForGitRepos: only .git-bearing children; unreadable dir → []', () => {
    const parent = makeTmp();
    makeRepo(parent, 'a');
    mkdirSync(join(parent, 'plain'));
    expect(scanForGitRepos(parent)).toEqual([join(parent, 'a')]);
    expect(scanForGitRepos(join(parent, 'missing'))).toEqual([]);
  });

  it('renderProjectsJson omits an empty settings block and ends with a newline', () => {
    const none = renderProjectsJson([{ id: 'a', name: 'A', path: '/a' }], {});
    expect(none).not.toContain('"settings"');
    expect(none.endsWith('\n')).toBe(true);
    const some = renderProjectsJson([], { theme: 'highContrast' });
    expect(parseSettingsPreset(some)).toEqual({ theme: 'highContrast' });
  });
});
