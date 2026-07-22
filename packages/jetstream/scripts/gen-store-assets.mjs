// Generate Marketplace store assets (thumbnail + gallery) and the site's og-card from the
// plugin's key faces. keyFace's SVG template is mirrored inline (kept in sync with
// src/render.ts); the status colours are imported from @pimmesz/jetstream-status rather than
// copied, so the marketing can never claim a colour the product doesn't ship.
//
// They did drift, before this import existed: the hand-copied table painted `working` as
// #e5484d — a red the status package explicitly reserves for danger (deny / stop / error),
// and which index.test.ts asserts no project status may ever use — and `idle` as #0091ff,
// which is actually `done` in the high-contrast theme. Every gallery shipped both mistakes.
// Composes an on-brand HTML mockup of a lit Stream Deck and screenshots it to PNG with an
// installed Google Chrome. Output: packages/jetstream/marketing/*.png + docs/og-card.png
//
// Typography is host-dependent: the stack resolves to SF on macOS and Noto Sans on a stock
// Linux box, so the same commit renders slightly different text metrics per machine. Copy
// stays inside its container either way, but expect a pixel diff if these are regenerated
// somewhere new — that is churn, not a bug.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { colorFor } from '@pimmesz/jetstream-status';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(dirname(PKG));
const OUT = join(PKG, 'marketing');
const DOCS = join(ROOT, 'docs');
// Chrome lives in a different place on every platform, and the generator is useful from CI
// and a Linux box, not just the author's Mac. Take $CHROME first, then the usual paths.
const CHROME = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
].find((p) => p && existsSync(p));
mkdirSync(OUT, { recursive: true });

// Real status colours (default theme), read from the product rather than restated here.
// Requires the cores to be built first (`pnpm build:cores` from the repo root).
const C = {
  working: colorFor('working'),
  needsInput: colorFor('needsInput'),
  done: colorFor('done'),
  none: colorFor('none'),
};

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
const fit = (t, max = 10) => (String(t).length <= max ? String(t) : String(t).slice(0, max - 1) + '…');

// Mirror of render.ts keyFace → data:image/svg+xml URI.
function keyFace(f) {
  const label = esc(fit(f.label));
  const subMax = f.subMax ?? 14;
  const sub = f.sub === undefined ? '' : esc(fit(f.sub, subMax));
  const subFont = subMax > 16 ? 14 : 18;
  const top = f.top === undefined ? '' : esc(fit(f.top, 14));
  const glyph = f.glyph ? esc(f.glyph) : '';
  const FF = '-apple-system,Segoe UI,sans-serif';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<rect width="144" height="144" rx="18" fill="${esc(f.color)}"/>` +
    (glyph ? `<text x="18" y="34" font-family="${FF}" font-size="22" font-weight="700" fill="#ffffff">${glyph}</text>` : '') +
    (top ? `<text x="72" y="42" text-anchor="middle" font-family="${FF}" font-size="18" fill="rgba(255,255,255,0.85)">${top}</text>` : '') +
    `<text x="72" y="82" text-anchor="middle" font-family="${FF}" font-size="26" font-weight="700" fill="#ffffff">${label}</text>` +
    (sub ? `<text x="72" y="112" text-anchor="middle" font-family="${FF}" font-size="${subFont}" fill="rgba(255,255,255,0.85)">${sub}</text>` : '') +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const K = (f) => `<div class="cell"><img src="${keyFace(f)}"/></div>`;
const BLANK = `<div class="cell"></div>`;
const deck = (cells, cols, k = 118) => `<div class="deck" style="grid-template-columns:repeat(${cols},1fr);--k:${k}px">${cells.join('')}</div>`;

// The brand mark, inlined as a data URI. Chrome blocks file:// subresources from a file:// page,
// and these pages are screenshotted out of tmpdir, so a path reference would render an empty box;
// base64 always resolves.
const LOGO = `data:image/png;base64,${readFileSync(join(DOCS, 'jetstream-logo.png')).toString('base64')}`;
// A logo key: the bundled Jetstream mark on a near-black key (slot kind 'logo'). It ships on the
// default board and a press opens `jetstream chat` — it took the slot the removed Settings key held.
const LOGO_CELL = `<div class="cell"><img src="${LOGO}" style="object-fit:contain;padding:26px;box-sizing:border-box;background:#0b0d12"/></div>`;
// An app-shortcut key (Telegram): the plugin auto-shows the app's own icon; approximated here with
// the app's brand colour since a screenshot mockup can't embed installed-app icons.
const TELEGRAM = `<div class="cell"><img src="${keyFace({ color: '#229ED9', label: 'Telegram' })}"/></div>`;

// A representative XL board — the SAME layout + key faces the plugin actually renders: real status
// colours from the product, and NO decorative corner glyphs (the corner glyph is reserved for a
// stall, a failure, or a working key showing its tool, none of which are lit here). 8 columns × 4 rows.
const boardCells = [
  // row a — projects, with the Jetstream mark on a8
  K({ color: C.working, label: 'falcon', sub: 'working' }),
  K({ color: C.done, label: 'api', subMax: 20, sub: 'done 4m · +12/-3' }),
  K({ color: C.none, label: 'docs' }),
  K({ color: C.working, label: 'web', sub: 'working 10m' }),
  K({ color: C.working, label: 'infra', sub: 'working 2m' }),
  K({ color: C.working, label: 'cli', sub: 'working 2m' }),
  K({ color: C.needsInput, label: 'jetstream', subMax: 18, sub: 'answer in Claude' }),
  LOGO_CELL,
  // rows b, c — unlit
  BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK,
  BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK,
  // row d — usage gauge (d1), Telegram (d7), stop-all (d8); 8 cells so the board is a full 8×4 = 32
  // Gauge under 50% of budget → the product's gaugeColor() paints it green (#30a46c == C.done), so
  // mirror that with C.done rather than a hardcoded amber that would drift from the real thresholds.
  K({ color: C.done, top: '5h 20%', label: '7d 42%', subMax: 22, sub: 'resets 3h45m' }),
  BLANK, BLANK, BLANK, BLANK, BLANK,
  TELEGRAM,
  K({ color: '#e5484d', label: 'stop all', sub: '4 working' }),
];

const PAGE = (inner, w, h) => `<!doctype html><html><head><meta charset="utf-8"/><style>
  html,body{margin:0}
  body{width:${w}px;height:${h}px;overflow:hidden;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#f4f4f5;
    background:radial-gradient(900px 460px at 50% -120px,rgba(56,189,248,0.18),transparent 70%),linear-gradient(180deg,#0d0d0f,#0a0a0b);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px}
  .brand{display:flex;align-items:center;gap:18px}
  .brand .jet{width:78px;height:78px;display:block;filter:drop-shadow(0 6px 22px rgba(56,189,248,0.4))}
  .brand h1{font-size:52px;margin:0;letter-spacing:-0.02em;font-weight:800}.flame{color:#38bdf8}
  .tag{font-size:23px;color:#a1a1aa;margin:0;max-width:1000px;text-align:center}
  /* Mirror the Stream Deck app preview: flat matte key faces with rounded corners, a thin top
     highlight and a soft shadow between keys — not a glossy moulding. --k = key size per deck. */
  .deck{display:grid;gap:12px;padding:22px;background:#141416;border:1px solid #26262b;border-radius:22px;box-shadow:0 26px 80px rgba(0,0,0,0.5)}
  .cell{position:relative;width:var(--k,118px);height:var(--k,118px);border-radius:16px;background:#1b1b1e;box-shadow:0 2px 4px rgba(0,0,0,0.45)}
  .cell img{width:100%;height:100%;display:block;border-radius:16px}
  .cell::after{content:"";position:absolute;inset:0;border-radius:16px;pointer-events:none;box-shadow:inset 0 1px 0 rgba(255,255,255,0.10)}
  .cap{font-size:22px;color:#d4d4d8;margin:0;text-align:center;max-width:880px}
</style></head><body>${inner}</body></html>`;
const BRAND = `<div class="brand"><img class="jet" src="${LOGO}" alt=""/><h1>Jet<span class="flame">stream</span></h1></div>`;

const assets = [
  { name: 'thumbnail.png', w: 640, h: 640, html: PAGE(`${BRAND}<p class="tag">Claude Code, live on your Stream Deck.</p>${deck(boardCells.slice(0, 5), 5, 100)}`, 640, 640) },
  { name: 'gallery-1-board.png', w: 960, h: 540, html: PAGE(`<p class="cap">A live status board for every project: working, needs you, done.</p>${deck(boardCells, 8, 96)}`, 960, 540) },
  { name: 'gallery-3-hero.png', w: 960, h: 540, html: PAGE(`${BRAND}<p class="tag">Status board · attention doorbell · usage gauge · deck approvals · built by chat.</p>${deck(boardCells.slice(0, 8), 8, 96)}`, 960, 540) },
  // The site's social preview. Generated from the same brand + board as the gallery so the
  // og-card can't drift from the store assets the way a hand-copied file does.
  { name: 'og-card.png', dir: DOCS, w: 960, h: 540, html: PAGE(`${BRAND}<p class="tag">Status board · attention doorbell · usage gauge · deck approvals · built by chat.</p>${deck(boardCells.slice(0, 8), 8, 96)}`, 960, 540) },
];

if (!CHROME) {
  throw new Error(
    'Google Chrome not found. Set $CHROME to its binary, or install Chrome/Chromium at one of the standard paths.',
  );
}
for (const a of assets) {
  const dest = join(a.dir ?? OUT, a.name);
  const htmlFile = join(tmpdir(), `store-${a.name}.html`);
  writeFileSync(htmlFile, a.html);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=2', `--window-size=${a.w},${a.h}`, `--screenshot=${dest}`, pathToFileURL(htmlFile).href], { stdio: 'ignore' });
  console.log(`  ${a.name}  (${a.w * 2}×${a.h * 2}px)`);
  rmSync(htmlFile, { force: true });
}
console.log(`\nWrote ${assets.length} asset(s).`);
