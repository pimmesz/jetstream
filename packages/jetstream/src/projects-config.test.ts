import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProjectsConfig,
  parseSettingsPreset,
  projectsConfigPath,
  readConfigFile,
} from './projects-config';

describe('parseProjectsConfig', () => {
  it('parses valid projects', () => {
    const raw = JSON.stringify({
      projects: [{ id: 'falcon', name: 'Falcon', path: '/home/me/falcon' }],
    });
    expect(parseProjectsConfig(raw)).toEqual([
      { id: 'falcon', name: 'Falcon', path: '/home/me/falcon' },
    ]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseProjectsConfig('{not json')).toEqual([]);
  });

  it('returns [] when the projects key is missing or not an array', () => {
    expect(parseProjectsConfig('{}')).toEqual([]);
    expect(parseProjectsConfig(JSON.stringify({ projects: 'nope' }))).toEqual([]);
  });

  it('drops entries missing id, name, or path', () => {
    const raw = JSON.stringify({
      projects: [
        { id: 'ok', name: 'OK', path: '/p' },
        { id: 'no-path', name: 'X' },
        { name: 'no-id', path: '/p' },
        { id: 'blank', name: '  ', path: '/p' },
      ],
    });
    expect(parseProjectsConfig(raw)).toEqual([{ id: 'ok', name: 'OK', path: '/p' }]);
  });

  it('keeps the first of duplicate ids', () => {
    const raw = JSON.stringify({
      projects: [
        { id: 'dup', name: 'First', path: '/a' },
        { id: 'dup', name: 'Second', path: '/b' },
      ],
    });
    expect(parseProjectsConfig(raw)).toEqual([{ id: 'dup', name: 'First', path: '/a' }]);
  });
});

describe('parseSettingsPreset', () => {
  it('extracts known settings fields and ignores the rest', () => {
    const raw = JSON.stringify({ settings: { theme: 'highContrast', longPressMs: 700, bogus: 1 } });
    expect(parseSettingsPreset(raw)).toEqual({ theme: 'highContrast', longPressMs: 700 });
  });

  it('returns {} for malformed JSON or a missing settings block', () => {
    expect(parseSettingsPreset('nope')).toEqual({});
    expect(parseSettingsPreset('{}')).toEqual({});
  });
});

describe('projectsConfigPath', () => {
  it('uses $XDG_CONFIG_HOME when set', () => {
    expect(projectsConfigPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(
      '/cfg/jetstream/projects.json',
    );
  });

  it('falls back to ~/.config when XDG is unset', () => {
    expect(projectsConfigPath({}, '/home/me')).toBe('/home/me/.config/jetstream/projects.json');
  });
});

describe('readConfigFile', () => {
  it('degrades a missing file to empty defaults, never throwing', () => {
    // The load-bearing "no projects.json → behave exactly as before" guarantee.
    expect(readConfigFile('/no/such/jetstream/projects.json')).toEqual({
      projects: [],
      settings: {},
    });
  });

  it('reads and parses a present file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-cfg-'));
    const path = join(dir, 'projects.json');
    writeFileSync(
      path,
      JSON.stringify({
        projects: [{ id: 'a', name: 'A', path: '/a' }],
        settings: { theme: 'highContrast' },
      }),
    );
    try {
      expect(readConfigFile(path)).toEqual({
        projects: [{ id: 'a', name: 'A', path: '/a' }],
        settings: { theme: 'highContrast' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a present-but-unparseable file as corrupt (so a mutation refuses to clobber it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-cfg-'));
    const path = join(dir, 'projects.json');
    // Valid-looking fleet, but truncated JSON — the exact data-loss trap.
    writeFileSync(path, '{ "projects": [ { "id": "a", "name": "A", "path": "/a" }');
    try {
      const cfg = readConfigFile(path);
      expect(cfg.corrupt).toBe(true);
      expect(cfg.projects).toEqual([]); // reads empty, but corrupt tells writers to stand down
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a MISSING file is not corrupt (a first add legitimately starts empty)', () => {
    expect(readConfigFile('/no/such/jetstream/projects.json').corrupt).toBeUndefined();
  });
});
