#!/usr/bin/env node
// Render README.md into docs/index.html between the README:START / README:END
// markers. README.md is the single source of truth; the landing page's
// "Full documentation" block is generated and must never be hand-edited.
//
// Run locally with `node scripts/render-landing.mjs`, or automatically via
// .github/workflows/sync-landing.yml on every push to main that touches the
// README. Markdown is rendered by spawning `npx marked`, so this adds nothing
// to package.json / pnpm-lock.yaml.
//
// Two notable details: the version for the
// JSON-LD comes from packages/jetstream/package.json (the published package, not
// the private workspace root, which is pinned at 0.0.0), and the site is served from its
// custom domain (getjetstream.dev, via docs/CNAME) rather than the GitHub Pages subpath.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const PAGE = join(root, 'docs', 'index.html');
const LLMS = join(root, 'docs', 'llms.txt');
const PKG = join(root, 'packages', 'jetstream', 'package.json');
const REPO = 'pimmesz/jetstream';
const SITE = 'https://getjetstream.dev/';
const START = '<!-- README:START -->';
const END = '<!-- README:END -->';
const SUMMARY =
  'Full Claude Code control on your Elgato Stream Deck. One key per project, glowing with that ' +
  "project's live status — working, needs-you, done — plus an attention doorbell, usage gauges, " +
  'deck-answerable permission prompts. Build the whole board by ' +
  'talking to it.';

// 1. Read the README and drop the top matter (title, tagline): the mirror starts
//    at the first level-2 heading. One deterministic rule, no per-README tuning,
//    and the landing hero already covers the pitch above it.
const md = readFileSync(README, 'utf8');
const firstH2 = md.search(/^## /m);
if (firstH2 === -1) {
  throw new Error('README.md has no "## " heading to start the mirror from.');
}
const body = md.slice(firstH2);

// 2. Render markdown -> HTML with the marked CLI. Pinned to an exact version:
//    this runs in a contents:write job, so a floating `@12` (any 12.x patch)
//    would let a compromised release execute against a push-to-main token. An
//    exact pin is the minimal fix that avoids adding a package.json dependency.
//    marked reads/writes via -i/-o files rather than stdin/stdout: capturing
//    `npx`'s forwarded stdout through spawnSync silently truncates at ~8 KB (one
//    pipe buffer). A file round trip sidesteps the capture entirely.
const tmp = mkdtempSync(join(tmpdir(), 'jetstream-landing-'));
let html;
try {
  const inFile = join(tmp, 'body.md');
  const outFile = join(tmp, 'body.html');
  writeFileSync(inFile, body);
  // stdin/stdout are unused (marked reads/writes the -i/-o files), but forward
  // stderr so a marked/npx failure is diagnosable in the contents:write CI job
  // instead of vanishing.
  execFileSync('npx', ['-y', 'marked@12.0.2', '-i', inFile, '-o', outFile], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  html = readFileSync(outFile, 'utf8').trim();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3. Give headings GitHub-style id slugs so in-page anchors resolve. Duplicate
//    headings get GitHub-style `-1`, `-2` suffixes via a per-render seen-map so
//    two identical headings don't collide on the same anchor.
const baseSlug = (text) =>
  text
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
const seenSlugs = new Map();
const slug = (text) => {
  const base = baseSlug(text);
  const seen = seenSlugs.get(base) ?? 0;
  seenSlugs.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
};
html = html.replace(
  /<(h[23])>(.*?)<\/\1>/g,
  (_m, tag, inner) => `<${tag} id="${slug(inner)}">${inner}</${tag}>`,
);

// 4. Rewrite repo-relative links/images to absolute URLs so nothing 404s once
//    the README content is lifted out of the repo and onto the site.
html = html.replace(/(href|src)="(?!https?:|#|mailto:)([^"]+)"/g, (_m, attr, path) => {
  const clean = path.replace(/^\.\//, '');
  const base =
    attr === 'src'
      ? `https://raw.githubusercontent.com/${REPO}/main/`
      : `https://github.com/${REPO}/blob/main/`;
  return `${attr}="${base}${clean}"`;
});

// 5. Splice the rendered HTML between the markers, leaving everything else in
//    the hand-designed page untouched.
const page = readFileSync(PAGE, 'utf8');
const s = page.indexOf(START);
const e = page.indexOf(END);
if (s === -1 || e === -1 || e < s) {
  throw new Error(`Markers ${START} / ${END} not found (in order) in docs/index.html.`);
}
const note =
  '\n<!-- Generated from README.md by scripts/render-landing.mjs — do not edit by hand. -->\n';
const spliced = page.slice(0, s + START.length) + note + html + '\n' + page.slice(e);

// 5b. Keep the JSON-LD softwareVersion in lockstep with the published package so
//     a release bump can't leave the structured data stale.
const pkgVersion = JSON.parse(readFileSync(PKG, 'utf8')).version;
const next = spliced.replace(/("softwareVersion":\s*")[^"]*(")/, `$1${pkgVersion}$2`);

if (next === page) {
  console.log('Landing page already in sync with README.');
} else {
  writeFileSync(PAGE, next);
  console.log('Landing page synced from README.');
}

// 6. Generate docs/llms.txt from the same README so LLMs get a clean, always
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
