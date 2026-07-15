// Build everything the npm tarball ships, in one self-contained door. Runs at `prepack`
// (i.e. `npm publish` / `npm pack`), so the tarball always carries artifacts built from the
// CURRENT source. NOT part of `pnpm build` — dev builds stay fast.
//
// WHY THIS BUILDS THE CORES ITSELF (the important bit):
// This exact step, when it lived in afterburner, assumed CI had already built the sibling
// cores. It hadn't — the publish job ran `npm publish` straight after install, so esbuild hit
// "Could not resolve @pimmesz/jetstream-status" (the core's package.json `main` points at a
// dist/ that didn't exist yet), prepack threw, and EVERY publish failed silently from
// afterburner 3.6.0 onward while the repo kept version-bumping to 3.11.0. Ordering that lives
// in a workflow can drift away from the script that depends on it; ordering that lives HERE
// cannot. So: prepack builds its own prerequisites, and asserts its outputs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/jetstream
const outDir = join(pkgDir, 'assets');
const artifact = join(outDir, 'gg.pim.jetstream.streamDeckPlugin');

const run = (cmd, args, cwd = pkgDir) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

// 1. The cores the plugin bundle imports by package name (@pimmesz/jetstream-{status,claude,
//    usage}). esbuild resolves them through the workspace symlink to their `main` → dist/,
//    so they MUST be built before the plugin bundle, in this process, not by a caller.
console.log('prepack: building cores…');
run('pnpm', [
  '--filter',
  '@pimmesz/jetstream-usage',
  '--filter',
  '@pimmesz/jetstream-claude',
  '--filter',
  '@pimmesz/jetstream-status',
  'run',
  'build',
]);

// 2. The plugin bundle (bin/plugin.js + hooks + CLI) — everything the Stream Deck runtime runs.
console.log('prepack: building the plugin bundle…');
run('node', [join(pkgDir, 'scripts', 'build.mjs')]);

// 3. The `jetstream` bin this package puts on PATH (installer + passthrough). Separate from
//    the plugin bundle: this one runs from node_modules, the plugin runs inside Stream Deck.
console.log('prepack: building the npm CLI…');
run('pnpm', [
  'exec',
  'tsup',
  'src/bin/npm-cli-entry.ts',
  '--format',
  'esm',
  '--clean',
  '--out-dir',
  'dist',
]);

// 4. Pack the installable, overwriting any stale copy. --no-update-check keeps it
//    offline/deterministic. validate first: a plugin that fails Elgato's own checks must
//    never reach the registry.
console.log('prepack: validating + packing the plugin…');
run('pnpm', ['exec', 'streamdeck', 'validate', 'gg.pim.jetstream.sdPlugin']);
rmSync(artifact, { force: true });
mkdirSync(outDir, { recursive: true });
run('pnpm', [
  'exec',
  'streamdeck',
  'pack',
  'gg.pim.jetstream.sdPlugin',
  '--force',
  '--no-update-check',
  '--output',
  outDir,
]);

// 5. Assert every shipped artifact exists. Without this, a silently-empty build would ship a
//    tarball whose `jetstream install` fails on the user's machine instead of in CI.
const required = [artifact, join(pkgDir, 'dist', 'npm-cli-entry.js')];
for (const file of required) {
  if (!existsSync(file)) throw new Error(`prepack: expected artifact missing — ${file}`);
}
console.log(`prepack: ready — packed plugin at ${artifact}`);
