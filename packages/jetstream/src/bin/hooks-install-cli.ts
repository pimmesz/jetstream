import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installHooks } from '../hooks-install';

/**
 * `node <plugin>/bin/hooks-install.js` — one-time setup, run from wherever the
 * .sdPlugin is installed. Wires the bundled status hook (per-project colours) and,
 * only when no statusline exists yet, the usage hook (the gauges) into
 * `~/.claude/settings.json`. Idempotent; backs the file up once before writing.
 */
async function main(): Promise<void> {
  const bin = dirname(fileURLToPath(import.meta.url));
  const node = process.execPath;
  const cmd = (file: string): string => `"${node}" "${join(bin, file)}"`;
  try {
    const result = await installHooks({
      commands: {
        status: cmd('status-hook.js'),
        permission: cmd('permission-hook.js'),
        usage: cmd('usage-hook.js'),
      },
    });
    if (result.changed) {
      console.log(`Jetstream hooks installed into ${result.settingsPath}`);
      if (result.backupPath) console.log(`(previous settings backed up to ${result.backupPath})`);
      console.log('Restart any running `claude` sessions to pick them up.');
    } else {
      console.log('Jetstream hooks were already installed — nothing changed.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
