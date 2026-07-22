#!/usr/bin/env node
// Keep the landing page's structured data and docs/llms.txt in sync with the
// published package + README. README.md stays the single source of truth. The page
// no longer mirrors the README body; this script only (1) keeps the JSON-LD
// softwareVersion in lockstep with the published package, and (2) regenerates
// docs/llms.txt from the README so LLMs get a clean, current map in one fetch.
//
// Run locally with `node scripts/render-landing.mjs`, or automatically via
// .github/workflows/sync-landing.yml on every push to main that touches the README.
//
// Two notable details: the version for the JSON-LD comes from
// packages/jetstream/package.json (the published package, not the private workspace
// root, which is pinned at 0.0.0), and the site is served from its custom domain
// (getjetstream.dev, via docs/CNAME) rather than the GitHub Pages subpath.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const PAGE = join(root, 'docs', 'index.html');
const LLMS = join(root, 'docs', 'llms.txt');
const PKG = join(root, 'packages', 'jetstream', 'package.json');
const REPO = 'pimmesz/jetstream';
const SITE = 'https://getjetstream.dev/';
const SUMMARY =
  'Claude Code on your Elgato Stream Deck. One key per project, glowing with that ' +
  "project's live status (working, needs-you, done), plus an attention doorbell, usage " +
  'gauges, and deck-answerable permission prompts. Build the whole board by talking to it.';

// 1. Read the README and drop the top matter (title, tagline): the mirror starts
//    at the first level-2 heading. One deterministic rule, no per-README tuning.
const md = readFileSync(README, 'utf8');
const firstH2 = md.search(/^## /m);
if (firstH2 === -1) {
  throw new Error('README.md has no "## " heading to start the mirror from.');
}
const body = md.slice(firstH2);

// 2. Keep the JSON-LD softwareVersion in lockstep with the published package so a
//    release bump can't leave the structured data stale.
const page = readFileSync(PAGE, 'utf8');
const pkgVersion = JSON.parse(readFileSync(PKG, 'utf8')).version;
const next = page.replace(/("softwareVersion":\s*")[^"]*(")/, `$1${pkgVersion}$2`);
if (next === page) {
  console.log('Landing page softwareVersion already in sync.');
} else {
  writeFileSync(PAGE, next);
  console.log(`Landing page softwareVersion synced to ${pkgVersion}.`);
}

// 3. Generate docs/llms.txt from the same README so LLMs get a clean, always
//    current markdown map + full body in one fetch (https://llmstxt.org). The
//    README stays the single source of truth; this file is never hand-edited.
const mdBody = body.replace(
  /(!?\[[^\]]*\])\(((?!https?:|#|mailto:)[^)]+)\)/g,
  (_m, label, path) => {
    const clean = path.replace(/^\.\//, '');
    const base = label.startsWith('!')
      ? `https://raw.githubusercontent.com/${REPO}/main/`
      : `https://github.com/${REPO}/blob/main/`;
    return `${label}(${base}${clean})`;
  },
);
const llms =
  `# Jetstream\n\n` +
  `> ${SUMMARY}\n\n` +
  `- [Website](${SITE})\n` +
  `- [Source (GitHub)](https://github.com/${REPO})\n` +
  `- [npm package](https://www.npmjs.com/package/@pimmesz/jetstream)\n\n` +
  `## Full documentation\n\n` +
  `${mdBody.trim()}\n`;
const prevLlms = existsSync(LLMS) ? readFileSync(LLMS, 'utf8') : '';
if (prevLlms === llms) {
  console.log('llms.txt already in sync with README.');
} else {
  writeFileSync(LLMS, llms);
  console.log('llms.txt synced from README.');
}
