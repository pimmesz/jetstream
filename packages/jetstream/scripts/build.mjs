// Bundle the plugin with esbuild directly (not tsup): everything the Stream Deck
// app runs must be self-contained in the .sdPlugin (its Node runtime has no
// node_modules), and we need two esbuild details tsup doesn't expose cleanly:
//
// 1. absWorkingDir OUTSIDE the home tree. esbuild auto-detects a Yarn PnP manifest
//    (`.pnp.cjs`) in any ancestor of its working dir and then FORBIDS normal
//    node_modules resolution; a stray manifest in a parent dir (e.g. $HOME) breaks
//    the bundle. Import resolution is per-source-file, so pointing absWorkingDir at
//    the OS temp dir disables the false PnP detection without affecting anything.
// 2. A createRequire banner: bundling CJS deps into ESM output leaves `require()`
//    shims that throw "Dynamic require is not supported" at runtime without it.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkg, 'gg.pim.jetstream.sdPlugin', 'bin');

await build({
  absWorkingDir: tmpdir(),
  entryPoints: {
    plugin: join(pkg, 'src', 'plugin.ts'),
    'hooks-install': join(pkg, 'src', 'bin', 'hooks-install-cli.ts'),
    'status-hook': join(pkg, '..', 'status', 'src', 'hook.ts'),
    'permission-hook': join(pkg, '..', 'status', 'src', 'permission-hook.ts'),
    'usage-hook': join(pkg, '..', 'usage', 'src', 'hook.ts'),
  },
  outdir: bin,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// The .sdPlugin folder has no package.json, so mark bin/ as ESM.
writeFileSync(join(bin, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
console.log('bundle complete: bin/plugin.js + hooks + {"type":"module"} marker');
