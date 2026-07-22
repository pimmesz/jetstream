import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { run } from '../cli';

/**
 * `node "<plugin>/bin/jetstream.js" <command>` — the Jetstream CLI, run from inside the installed
 * .sdPlugin OR via the `jetstream` npm bin (see package.json), which forwards every verb except
 * install/update/version. For the full subcommand list see the `USAGE` string in ../cli.ts.
 */
const binDir = dirname(fileURLToPath(import.meta.url));
process.exitCode = await run(process.argv.slice(2), binDir);
