import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { run } from '../cli';

/**
 * `node "<plugin>/bin/jetstream.js" <command>` — the Jetstream CLI, run from wherever the
 * .sdPlugin is installed (it ships via the Elgato Marketplace, so there's no PATH command).
 * Subcommands: `hooks install [--tool-detail]`, `doctor`, `setup`.
 */
const binDir = dirname(fileURLToPath(import.meta.url));
process.exitCode = await run(process.argv.slice(2), binDir);
