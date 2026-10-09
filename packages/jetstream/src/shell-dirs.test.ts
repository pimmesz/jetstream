import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSessionsDir, resolveCodexUsage } from '@pimmesz/jetstream-usage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookCommands, installHooks } from './hooks-install';
import { adoptShellDirs, readOwned, recordShellDirs, shellDirsPath } from './shell-dirs';

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jetstream-shell-dirs-'));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** What a plugin with an empty env would adopt from the record at `path`. */
const adopted = (path: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  adoptShellDirs(env, path);
  return env;
};
const isPosix = process.platform !== 'win32';

describe('shell dirs: the plugin uses the dirs your shell had', () => {
  it('records under ~/.jetstream, a path no env var moves', () => {
    expect(shellDirsPath('/home/me')).toBe(join('/home/me', '.jetstream', 'shell-dirs.json'));
  });

  it('a plugin started without CLAUDE_CONFIG_DIR wires hooks into the recorded dir', async () => {
    // HOME points at a temp dir, so even a broken adopt can never write the real ~/.claude.
    const home = makeTmp();
    vi.stubEnv('HOME', home);
    const configDir = join(makeTmp(), 'claude-config');
    const recordPath = shellDirsPath(home);
    expect(recordShellDirs({ CLAUDE_CONFIG_DIR: configDir }, recordPath)).toContain(configDir);

    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    adoptShellDirs(process.env, recordPath);
    const result = await installHooks({ commands: hookCommands('/plugin/bin', false) });

    expect(result.settingsPath).toBe(join(configDir, 'settings.json'));
    expect(readFileSync(result.settingsPath, 'utf8')).toContain('status-hook.js');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('the Codex gauge reads the sessions under the recorded CODEX_HOME', async () => {
    const home = makeTmp();
    vi.stubEnv('HOME', home);
    const codexHome = makeTmp();
    const day = join(codexHome, 'sessions', '2026', '10', '06');
    mkdirSync(day, { recursive: true });
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const rateLimits = {
      limit_id: 'codex',
      primary: { used_percent: 37, window_minutes: 10080, resets_at: resetsAt },
    };
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      payload: { type: 'token_count', rate_limits: rateLimits },
    });
    writeFileSync(join(day, 'rollout-a.jsonl'), `${line}\n`);
    const recordPath = shellDirsPath(home);
    recordShellDirs({ CODEX_HOME: codexHome }, recordPath);

    vi.stubEnv('CODEX_HOME', undefined);
    adoptShellDirs(process.env, recordPath);

    expect(codexSessionsDir()).toBe(join(codexHome, 'sessions'));
    expect(await resolveCodexUsage()).toMatchObject({ available: true, sevenDay: { usedPct: 37 } });
  });

  it("the plugin's own env wins over the record; an empty or blank value does not count", () => {
    const path = join(makeTmp(), 'shell-dirs.json');
    recordShellDirs({ CLAUDE_CONFIG_DIR: '/recorded/claude', CODEX_HOME: '/recorded/codex' }, path);

    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/from/launchctl', CODEX_HOME: '  ' };
    adoptShellDirs(env, path);

    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/from/launchctl', CODEX_HOME: '/recorded/codex' });
  });
});

describe('recordShellDirs mirrors the shell', () => {
  it('writes the set dirs 0600, trimmed, and skips one that is not an absolute path', () => {
    const path = join(makeTmp(), '.jetstream', 'shell-dirs.json');
    const note = recordShellDirs({ CLAUDE_CONFIG_DIR: '  /a/claude ', CODEX_HOME: '~/codex' }, path);

    expect(note).toContain('CLAUDE_CONFIG_DIR=/a/claude');
    expect(note).not.toContain('CODEX_HOME');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ CLAUDE_CONFIG_DIR: '/a/claude' });
    if (isPosix) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('leaves an unchanged record alone and says nothing', () => {
    const path = join(makeTmp(), 'shell-dirs.json');
    const env = { CLAUDE_CONFIG_DIR: '/a/claude', CODEX_HOME: '/a/codex' };
    recordShellDirs(env, path);
    const before = statSync(path);

    expect(recordShellDirs(env, path)).toBeUndefined();
    const after = statSync(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('removes the record once the shell sets neither, and creates nothing when there was none', () => {
    const dir = makeTmp();
    const path = join(dir, '.jetstream', 'shell-dirs.json');
    recordShellDirs({ CODEX_HOME: '/a/codex' }, path);

    expect(recordShellDirs({}, path)).toContain('goes back to ~/.claude and ~/.codex');
    expect(existsSync(path)).toBe(false);
    expect(recordShellDirs({}, path)).toBeUndefined();

    const fresh = join(dir, 'never', 'shell-dirs.json');
    expect(recordShellDirs({}, fresh)).toBeUndefined();
    expect(existsSync(join(dir, 'never'))).toBe(false);
  });

  it('rewrites a record the plugin would refuse, so the next run repairs it', () => {
    const path = join(makeTmp(), 'shell-dirs.json');
    const env = { CLAUDE_CONFIG_DIR: '/a/claude' };
    recordShellDirs(env, path);
    writeFileSync(path, '{ damaged');

    expect(recordShellDirs(env, path)).toContain('Recorded');
    expect(adopted(path)).toEqual(env);
  });

  it.skipIf(!isPosix)('rewrites an identical record that another user could write', () => {
    const path = join(makeTmp(), 'shell-dirs.json');
    const env = { CLAUDE_CONFIG_DIR: '/a/claude' };
    recordShellDirs(env, path);
    chmodSync(path, 0o666);

    expect(recordShellDirs(env, path)).toContain('Recorded');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(adopted(path)).toEqual(env);
  });

  it('a run as root (sudo) leaves the user record alone and says nothing', () => {
    const path = join(makeTmp(), 'shell-dirs.json');
    recordShellDirs({ CLAUDE_CONFIG_DIR: '/a/claude' }, path);

    expect(recordShellDirs({}, path, 0)).toBeUndefined();
    expect(recordShellDirs({ CLAUDE_CONFIG_DIR: '/b' }, path, 0)).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ CLAUDE_CONFIG_DIR: '/a/claude' });
  });

  it('never throws: a record it cannot write comes back as a note naming the file', () => {
    const blocker = join(makeTmp(), 'a-file');
    writeFileSync(blocker, '');
    const path = join(blocker, 'shell-dirs.json');

    const note = recordShellDirs({ CLAUDE_CONFIG_DIR: '/a/claude' }, path);

    expect(note).toContain(`Could not update ${path}`);
  });

  // Root ignores folder permissions, so this case cannot be set up as root.
  it.skipIf(!isPosix || process.getuid?.() === 0)(
    'never throws when the record cannot be removed either',
    () => {
      const folder = join(makeTmp(), '.jetstream');
      const path = join(folder, 'shell-dirs.json');
      recordShellDirs({ CODEX_HOME: '/a/codex' }, path);
      chmodSync(folder, 0o500);
      try {
        expect(recordShellDirs({}, path)).toContain(`Could not update ${path}`);
      } finally {
        chmodSync(folder, 0o700); // so afterEach can delete it
      }
    },
  );
});

describe('adoptShellDirs ignores a record it cannot trust', () => {
  const good = JSON.stringify({ CLAUDE_CONFIG_DIR: '/a/claude' });

  /** A record at a fresh path, written 0600 as the CLI writes it. */
  const plant = (text = good): string => {
    const path = join(makeTmp(), 'shell-dirs.json');
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  it('ignores content it does not understand', () => {
    expect(adopted(plant())).toEqual({ CLAUDE_CONFIG_DIR: '/a/claude' });
    const spoiled = [
      '{ not json',
      JSON.stringify(['/a/claude']),
      JSON.stringify(null),
      JSON.stringify({ CLAUDE_CONFIG_DIR: 'relative/claude' }),
      JSON.stringify({ CLAUDE_CONFIG_DIR: '/a/claude\n/b' }),
      JSON.stringify({ CLAUDE_CONFIG_DIR: '/a/\u001b[31mred' }),
      JSON.stringify({ CLAUDE_CONFIG_DIR: `/${'a'.repeat(1024)}` }),
      JSON.stringify({ CLAUDE_CONFIG_DIR: 42 }),
      JSON.stringify({ NODE_OPTIONS: '--require /tmp/x.js', PATH: '/tmp' }),
    ];
    for (const text of spoiled) expect(adopted(plant(text)), text).toEqual({});
  });

  it('ignores a record over 4 KB', () => {
    expect(adopted(plant(good.padEnd(4096)))).toEqual({ CLAUDE_CONFIG_DIR: '/a/claude' });
    expect(adopted(plant(good.padEnd(4097)))).toEqual({});
  });

  it('ignores a missing record and a folder in its place', () => {
    const dir = makeTmp();
    expect(adopted(join(dir, 'missing.json'))).toEqual({});
    mkdirSync(join(dir, 'shell-dirs.json'));
    expect(adopted(join(dir, 'shell-dirs.json'))).toEqual({});
  });

  it.skipIf(!isPosix)('ignores a symlink, even to a good record', () => {
    const target = plant();
    const link = join(makeTmp(), 'shell-dirs.json');
    symlinkSync(target, link);
    expect(adopted(link)).toEqual({});
  });

  it.skipIf(!isPosix)('ignores a FIFO without waiting for a writer', () => {
    const path = join(makeTmp(), 'shell-dirs.json');
    execFileSync('mkfifo', [path]);
    expect(adopted(path)).toEqual({});
  });

  it.skipIf(!isPosix)('ignores a record that another user could write', () => {
    for (const mode of [0o620, 0o602, 0o622]) {
      const path = plant();
      chmodSync(path, mode);
      expect(adopted(path), mode.toString(8)).toEqual({});
    }
  });

  it.skipIf(!isPosix)('ignores a record owned by another user', () => {
    const path = plant();
    const uid = process.getuid!();
    expect(readOwned(path, uid)).toBe(good);
    expect(readOwned(path, uid + 1)).toBeUndefined();
  });
});
