import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { run } from '../cli';

/**
 * Back-compat alias for `jetstream hooks install`. Setup used to be a single `hooks-install`
 * command (documented as `node "<plugin>/bin/hooks-install.js"`); it now lives under the
 * consolidated CLI, and this thin shim keeps the old invocation working. Extra args (e.g.
 * `--tool-detail`) forward straight through.
 */
const binDir = dirname(fileURLToPath(import.meta.url));
process.exitCode = await run(['hooks', 'install', ...process.argv.slice(2)], binDir);
