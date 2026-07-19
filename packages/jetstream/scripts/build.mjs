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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkg, 'gg.pim.jetstream.sdPlugin', 'bin');

// A compile-time build stamp, injected into the plugin bundle (esbuild `define`) and shown by
// the "Build version" key — so you can confirm the plugin running on the deck is THIS build.
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const BUILD_ID = `${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
// The npm package version this bundle was built from, baked in so /health can report it — the npm
// front door polls /health and only reports "live" once the version it just installed answers, so
// an `update` over a still-running old plugin can't report success before the new build loads.
const PKG_VERSION = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;

await build({
  absWorkingDir: tmpdir(),
  entryPoints: {
    plugin: join(pkg, 'src', 'plugin.ts'),
    jetstream: join(pkg, 'src', 'bin', 'jetstream-cli.ts'),
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
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __PKG_VERSION__: JSON.stringify(PKG_VERSION) },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// The .sdPlugin folder has no package.json, so mark bin/ as ESM.
writeFileSync(join(bin, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

// Bundled DEFAULT profiles (manifest `Profiles` array): regenerate the three
// .streamDeckProfile files from src/profile.ts so the shipped layouts can never
// drift from the single source of truth. profile.ts is bundled to a temp module
// first (this script is plain JS; esbuild is already here), then imported.
// Fixed profile ids + the STORE-only zip writer keep the output byte-reproducible.
const profileGenOut = join(tmpdir(), `jetstream-profile-gen-${process.pid}.mjs`);
await build({
  absWorkingDir: tmpdir(),
  entryPoints: { gen: join(pkg, 'src', 'profile.ts') },
  outfile: profileGenOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});
const {
  DECK_MODELS,
  DEFAULT_PROFILE_IDS,
  OPS_PROFILE_IDS,
  GRID_PROFILE_IDS,
  buildDefaultProfile,
  buildOpsProfile,
  buildGridProfile,
  defaultProfileName,
  opsProfileName,
  gridProfileName,
  renderProfileArchive,
} = await import(pathToFileURL(profileGenOut).href);
const profilesDir = join(pkg, 'gg.pim.jetstream.sdPlugin', 'profiles');
mkdirSync(profilesDir, { recursive: true });
for (const deck of DECK_MODELS) {
  const board = renderProfileArchive(buildDefaultProfile(deck), DEFAULT_PROFILE_IDS[deck.key]);
  writeFileSync(join(profilesDir, `${defaultProfileName(deck)}.streamDeckProfile`), board);
  // The Ops (second) page ships for the Standard + XL only (the Mini stays single-page).
  if (deck.key !== 'mini') {
    const ops = renderProfileArchive(buildOpsProfile(deck), OPS_PROFILE_IDS[deck.key]);
    writeFileSync(join(profilesDir, `${opsProfileName(deck)}.streamDeckProfile`), ops);
  }
  // The coordinate-grid overlay (toggled to via a Grid key) ships for every deck.
  const grid = renderProfileArchive(buildGridProfile(deck), GRID_PROFILE_IDS[deck.key]);
  writeFileSync(join(profilesDir, `${gridProfileName(deck)}.streamDeckProfile`), grid);
}
rmSync(profileGenOut, { force: true });

console.log('bundle complete: bin/plugin.js + hooks + default profiles + {"type":"module"} marker');
console.log(`build id: ${BUILD_ID}   (shown on the "Build version" key)`);
