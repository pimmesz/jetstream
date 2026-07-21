import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { JetstreamConfig } from './config';
import {
  addToFleet,
  handleFleetMessage,
  removeFromFleet,
  scanForGitRepos,
  writeFleetFile,
  type FleetDeps,
  type FleetOutbound,
  mergeFleet,
  renderProjectsJson,
} from './fleet';
import { parseProjectsConfig, parseSettingsPreset } from './projects-config';

const tmpDirs: string[] = [];
// realpath'd so assertions survive addToFleet's canonicalization (macOS /var → /private/var).
const makeTmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-fleet-')));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('addToFleet', () => {
  it('adds a project with a slug id and folder-basename name fallback', () => {
    const dir = makeTmp();
    const { projects, added, reason } = addToFleet([], { path: join(dir, 'falcon') });
    expect(reason).toBeUndefined();
    expect(added).toMatchObject({ id: 'falcon', name: 'falcon', path: join(dir, 'falcon') });
    expect(projects).toHaveLength(1);
  });

  it('honours an explicit name and uniquifies colliding ids', () => {
    const dir = makeTmp();
    let list: ProjectConfig[] = [];
    list = addToFleet(list, { path: join(dir, 'a'), name: 'Hawk' }).projects;
    const second = addToFleet(list, { path: join(dir, 'b'), name: 'Hawk' });
    expect(second.added).toMatchObject({ id: 'hawk-2', name: 'Hawk' });
  });

  it('dedups by CANONICAL path (a symlink to an existing repo is not re-added)', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, 'repo'));
    symlinkSync(join(dir, 'repo'), join(dir, 'link'));
    const first = addToFleet([], { path: join(dir, 'repo') });
    const second = addToFleet(first.projects, { path: join(dir, 'link') });
    expect(second.reason).toBe('duplicate');
    expect(second.projects).toHaveLength(1);
  });

  it('rejects an empty path', () => {
    expect(addToFleet([], { path: '   ' }).reason).toBe('empty-path');
  });

  it('expands a leading ~ so the in-app add field stores an absolute path', () => {
    const { added } = addToFleet([], { path: '~/some-nonexistent-repo-xyz' });
    expect(added).toBeDefined();
    expect(added!.path).toBe(join(homedir(), 'some-nonexistent-repo-xyz'));
    expect(added!.path).not.toContain('~');
  });

  it('strips control bytes (ESC/BEL) from the stored path and name', () => {
    const dir = makeTmp();
    const { added } = addToFleet([], { path: join(dir, 'falcon') + '\x1b\x07', name: 'Fal\x1bcon' });
    expect(added).toBeDefined();
    expect(added!.path).not.toMatch(/[\x00-\x1f\x7f]/); // no escapes reach projects.json
    expect(added!.name).toBe('Falcon');
  });

  it('is pure — never mutates the input list', () => {
    const dir = makeTmp();
    const input: ProjectConfig[] = [];
    addToFleet(input, { path: join(dir, 'x') });
    expect(input).toHaveLength(0);
  });
});

describe('scanForGitRepos', () => {
  const repo = (root: string, ...segs: string[]): string => {
    const dir = join(root, ...segs);
    mkdirSync(join(dir, '.git'), { recursive: true });
    return dir;
  };

  it('finds repos a few levels deep, skipping hidden + noise dirs', () => {
    const root = makeTmp();
    const loose = repo(root, 'loose'); // depth 1
    const app = repo(root, 'Personal', 'app'); // depth 2
    const zap = repo(root, 'Capgemini', 'cicd', 'zap'); // depth 3
    repo(root, '.nvm'); // hidden → skipped (the exact `~/.nvm` / `~/.oh-my-zsh` case)
    repo(root, 'node_modules', 'pkg'); // noise → skipped
    repo(root, 'deep', 'a', 'b', 'c'); // depth 4 → beyond the default maxDepth

    const found = scanForGitRepos(root);
    expect(found).toEqual([app, zap, loose].sort()); // exactly the three real repos
  });

  it('does not descend INTO a repo — a repo is a leaf, its subdirs are not separate repos', () => {
    const root = makeTmp();
    const app = repo(root, 'app');
    mkdirSync(join(app, 'packages', 'sub', '.git'), { recursive: true });
    expect(scanForGitRepos(root)).toEqual([app]);
  });

  it('returns [] for an unreadable/absent dir and never throws', () => {
    expect(scanForGitRepos('/no/such/dir/xyz')).toEqual([]);
  });
});

describe('removeFromFleet', () => {
  it('removes by id and no-ops on an unknown id', () => {
    const list: ProjectConfig[] = [
      { id: 'a', name: 'A', path: '/a' },
      { id: 'b', name: 'B', path: '/b' },
    ];
    expect(removeFromFleet(list, 'a')).toEqual([{ id: 'b', name: 'B', path: '/b' }]);
    expect(removeFromFleet(list, 'nope')).toEqual(list);
  });
});

describe('writeFleetFile', () => {
  it('writes a projects.json that round-trips through the plugin parser, settings preserved', () => {
    const path = join(makeTmp(), 'nested', 'projects.json');
    const projects: ProjectConfig[] = [{ id: 'a', name: 'A', path: '/a' }];
    writeFleetFile(path, projects, { theme: 'highContrast' });
    const raw = readFileSync(path, 'utf8');
    expect(parseProjectsConfig(raw)).toEqual(projects);
    expect(parseSettingsPreset(raw)).toEqual({ theme: 'highContrast' });
  });

  it('omits the settings block when empty', () => {
    const path = join(makeTmp(), 'projects.json');
    writeFleetFile(path, [{ id: 'a', name: 'A', path: '/a' }]);
    expect(readFileSync(path, 'utf8')).not.toContain('"settings"');
  });
});

describe('handleFleetMessage', () => {
  const makeDeps = (
    initial: ProjectConfig[],
    settings: Partial<JetstreamConfig> = {},
  ): { deps: FleetDeps; replies: FleetOutbound[]; state: () => ProjectConfig[] } => {
    let projects = initial;
    const replies: FleetOutbound[] = [];
    const deps: FleetDeps = {
      read: () => ({ projects, settings }),
      write: vi.fn((next) => {
        projects = next;
      }),
      seed: vi.fn(),
      reply: (msg) => {
        replies.push(msg);
      },
      scan: vi.fn(() => ['/scanned/repo-a', '/scanned/repo-b']),
    };
    return { deps, replies, state: () => projects };
  };

  it('list → replies with the current projects, no write', async () => {
    const { deps, replies } = makeDeps([{ id: 'a', name: 'A', path: '/a' }]);
    await handleFleetMessage({ fleet: 'list' }, deps);
    expect(replies).toEqual([{ fleet: 'projects', projects: [{ id: 'a', name: 'A', path: '/a' }] }]);
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('add → writes, re-seeds, and replies with the grown list', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-fleet-')));
    tmpDirs.push(dir);
    const { deps, replies, state } = makeDeps([]);
    await handleFleetMessage({ fleet: 'add', path: join(dir, 'falcon'), name: 'Falcon' }, deps);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.seed).toHaveBeenCalledTimes(1);
    expect(state()).toHaveLength(1);
    expect((replies[0] as { projects: ProjectConfig[] }).projects[0]).toMatchObject({ name: 'Falcon' });
  });

  it('add duplicate → no write/seed, note=duplicate', async () => {
    const { deps, replies } = makeDeps([{ id: 'a', name: 'A', path: '/a' }]);
    await handleFleetMessage({ fleet: 'add', path: '/a' }, deps);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.seed).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ fleet: 'projects', note: 'duplicate' });
  });

  it('remove → writes + re-seeds; unknown id → neither', async () => {
    const { deps } = makeDeps([{ id: 'a', name: 'A', path: '/a' }]);
    await handleFleetMessage({ fleet: 'remove', id: 'a' }, deps);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.seed).toHaveBeenCalledTimes(1);

    const clean = makeDeps([{ id: 'a', name: 'A', path: '/a' }]);
    await handleFleetMessage({ fleet: 'remove', id: 'ghost' }, clean.deps);
    expect(clean.deps.write).not.toHaveBeenCalled();
    expect(clean.deps.seed).not.toHaveBeenCalled();
  });

  it('add & remove preserve the on-disk settings block (threaded to write)', async () => {
    const preset = { theme: 'highContrast', longPressMs: 800 } as Partial<JetstreamConfig>;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-fleet-')));
    tmpDirs.push(dir);
    const { deps } = makeDeps([], preset);
    await handleFleetMessage({ fleet: 'add', path: join(dir, 'falcon') }, deps);
    expect(deps.write).toHaveBeenLastCalledWith(expect.any(Array), preset); // not {}
    await handleFleetMessage({ fleet: 'remove', id: 'falcon' }, deps);
    expect(deps.write).toHaveBeenLastCalledWith([], preset); // still preserved on remove
  });

  it('scan → replies with candidates, no write', async () => {
    const { deps, replies } = makeDeps([]);
    await handleFleetMessage({ fleet: 'scan', dir: '/some/dir' }, deps);
    expect(replies[0]).toEqual({
      fleet: 'candidates',
      dir: '/some/dir',
      candidates: ['/scanned/repo-a', '/scanned/repo-b'],
    });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('add/remove REFUSE to write when the config is corrupt (data-loss guard)', async () => {
    // A present-but-unparseable projects.json reads as empty+corrupt; writing would erase
    // the fleet we failed to parse. Both mutations must decline and report, never write.
    for (const message of [
      { fleet: 'add' as const, path: '/new/repo' },
      { fleet: 'remove' as const, id: 'a' },
    ]) {
      const write = vi.fn();
      const seed = vi.fn();
      const replies: FleetOutbound[] = [];
      const deps: FleetDeps = {
        read: () => ({ projects: [], settings: {}, corrupt: true }),
        write,
        seed,
        reply: (msg) => void replies.push(msg),
        scan: vi.fn(() => []),
      };
      await handleFleetMessage(message, deps);
      expect(write).not.toHaveBeenCalled();
      expect(seed).not.toHaveBeenCalled();
      expect(replies[0]?.fleet).toBe('error');
    }
  });

  it('a write failure replies fleet:error and does not seed (no silent loss)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-fleet-')));
    tmpDirs.push(dir);
    const seed = vi.fn();
    const replies: FleetOutbound[] = [];
    const deps: FleetDeps = {
      read: () => ({ projects: [], settings: {} }),
      write: vi.fn(() => {
        throw new Error('EROFS: read-only file system');
      }),
      seed,
      reply: (msg) => void replies.push(msg),
      scan: vi.fn(() => []),
    };
    await handleFleetMessage({ fleet: 'add', path: join(dir, 'falcon') }, deps);
    expect(seed).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ fleet: 'error' });
    expect((replies[0] as { message: string }).message).toContain('EROFS');
  });

  it('malformed payloads never throw and never write', async () => {
    const { deps } = makeDeps([]);
    for (const bad of [null, undefined, 'x', 42, {}, { fleet: 'nope' }, { fleet: 'add' }, { fleet: 'remove' }]) {
      await expect(handleFleetMessage(bad, deps)).resolves.toBeUndefined();
    }
    expect(deps.write).not.toHaveBeenCalled();
  });
});

// The bug: `jetstream chat` shows the model your BOARD, never your FLEET, and its instructions say
// to include only what the user asked for — so "add /repo/new" arrives as a ONE-project proposal.
// The apply path wrote that verbatim over projects.json, turning an add into a wipe of every other
// repo, atomically and with no backup.
describe('mergeFleet', () => {
  const p = (id: string, path: string): ProjectConfig => ({ id, name: id, path });

  it('an add is an ADD — it never drops repos the proposal omitted', () => {
    const existing = [p('falcon', '/r/falcon'), p('api', '/r/api'), p('web', '/r/web')];
    const merged = mergeFleet(existing, [p('new', '/r/new')]);
    expect(merged.map((x) => x.path)).toEqual(['/r/falcon', '/r/api', '/r/web', '/r/new']);
  });

  it('a repeated path is updated in place, not duplicated', () => {
    const merged = mergeFleet([p('old', '/r/falcon')], [{ id: 'falcon', name: 'Falcon', path: '/r/falcon' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name).toBe('Falcon'); // the proposal wins — this is how a rename works
  });

  // Both reviewers found this independently. The model is never shown the existing fleet, so its
  // ids are unique only within its own proposal — and parseProjectsConfig dedupes by id keeping the
  // FIRST, so a collision silently deletes the repo the user just asked for.
  it('re-uniquifies ids across the merge so an added repo cannot be swallowed', () => {
    const existing = [p('jetstream', '/Personal/jetstream')];
    const proposed = [{ id: 'jetstream', name: 'jetstream', path: '/work/jetstream' }];
    const merged = mergeFleet(existing, proposed);
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((x) => x.id)).size).toBe(2); // no collision
    // …and it survives a real write/read round-trip, which is where the loss actually happened.
    const roundTripped = parseProjectsConfig(renderProjectsJson(merged, {}));
    expect(roundTripped.map((x) => x.path)).toEqual(['/Personal/jetstream', '/work/jetstream']);
  });

  it('keeps an existing id when the SAME repo is re-emitted (ids address board state)', () => {
    const merged = mergeFleet([p('falcon', '/r/falcon')], [{ id: 'renamed', name: 'Falcon', path: '/r/falcon' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('falcon'); // id stable
    expect(merged[0]!.name).toBe('Falcon'); // rename still applies
  });

  it('never infers a removal from absence', () => {
    const existing = [p('a', '/r/a'), p('b', '/r/b')];
    expect(mergeFleet(existing, [])).toHaveLength(2);
  });
});

describe('writeFleetFile backup', () => {
  it('keeps the previous fleet before overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jetstream-fleet-'));
    const file = join(dir, 'projects.json');
    writeFleetFile(file, [{ id: 'a', name: 'A', path: '/r/a' }], {}, new Date('2026-07-21T10:00:00Z'));
    writeFleetFile(file, [{ id: 'b', name: 'B', path: '/r/b' }], {}, new Date('2026-07-21T11:00:00Z'));

    const backups = readdirSync(dir).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1); // the first write had nothing to preserve
    // The backup holds the PRE-overwrite fleet, so a bad write is recoverable.
    expect(JSON.parse(readFileSync(join(dir, backups[0]!), 'utf8')).projects[0].path).toBe('/r/a');
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[0].path).toBe('/r/b');
    rmSync(dir, { recursive: true, force: true });
  });
});
