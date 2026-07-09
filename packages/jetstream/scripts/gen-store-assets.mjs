// Generate Marketplace store assets (thumbnail + gallery) from the plugin's key faces.
// keyFace's SVG template is mirrored inline (kept in sync with src/render.ts) and the status
// colours/glyphs are the real values from @pimmesz/jetstream-status; no deps, no bundling.
// Composes an on-brand HTML mockup of a lit Stream Deck and screenshots it to PNG with the
// installed Google Chrome (macOS). Output: packages/jetstream/marketing/*.png
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(PKG, 'marketing');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

// Real status colours/glyphs (default theme) — mirror @pimmesz/jetstream-status.
const C = { working: '#e5484d', needsInput: '#ffb224', done: '#30a46c', idle: '#0091ff', none: '#3a3a3a' };

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
const deck = (cells, cols) => `<div class="deck" style="grid-template-columns:repeat(${cols},1fr)">${cells.join('')}</div>`;

const boardCells = [
  K({ color: C.needsInput, glyph: '!', label: 'fleet', sub: '2⋯ 1! 3✓' }),
  K({ color: C.needsInput, glyph: '!', label: 'attention', sub: 'api' }),
  K({ color: C.done, top: 'Opus 4.8', label: '5h 34%', subMax: 22, sub: '7d 62% · 3h33m' }),
  K({ color: '#1f6f43', label: 'approve', sub: 'api · ↵' }),
  K({ color: '#3a3a3a', label: 'settings', sub: 'setup 5/5' }),
  K({ color: C.working, glyph: '⋯', label: 'falcon', subMax: 20, sub: 'Bash · 12m' }),
  K({ color: C.needsInput, glyph: '!', label: 'api', sub: 'approve?' }),
  K({ color: C.done, glyph: '✓', label: 'web', subMax: 20, sub: '+120/-40 · 4m' }),
  K({ color: C.working, glyph: '⋯', label: 'docs', sub: 'Edit · 3m' }),
  K({ color: C.idle, glyph: '·', label: 'infra', sub: 'idle' }),
  BLANK, BLANK, BLANK, BLANK, BLANK,
];
const opsCells = [
  K({ color: '#3a3a3a', label: '← board', sub: 'status' }),
  K({ color: '#30a46c', label: 'engine', subMax: 22, sub: 'armed · 1 benched' }),
  K({ color: C.done, label: 'review', sub: '3 PRs · 2 ✓' }),
  K({ color: '#7c5cff', label: 'model', sub: 'opus' }),
  K({ color: C.working, label: 'stop all', sub: '2 working' }),
  K({ color: '#0091ff', label: 'ship tests', sub: 'set prompt' }),
  K({ color: '#0091ff', label: 'fix lint', sub: 'set prompt' }),
  K({ color: '#0091ff', label: 'launch', sub: 'set prompt' }),
  BLANK, K({ color: '#3a3a3a', label: 'settings', sub: 'contrast: off' }),
  BLANK, BLANK, BLANK, BLANK, BLANK,
];

const PAGE = (inner, w, h) => `<!doctype html><html><head><meta charset="utf-8"/><style>
  html,body{margin:0}
  body{width:${w}px;height:${h}px;overflow:hidden;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#f4f4f5;
    background:radial-gradient(900px 460px at 50% -120px,rgba(249,115,22,0.18),transparent 70%),linear-gradient(180deg,#0d0d0f,#0a0a0b);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px}
  .brand{display:flex;align-items:center;gap:14px}.brand .jet{font-size:44px}
  .brand h1{font-size:52px;margin:0;letter-spacing:-0.02em;font-weight:800}.flame{color:#f97316}
  .tag{font-size:23px;color:#a1a1aa;margin:0;max-width:840px;text-align:center}
  .deck{display:grid;gap:12px;padding:20px;background:#141416;border:1px solid #26262b;border-radius:22px;box-shadow:0 30px 90px rgba(0,0,0,0.5)}
  .cell{width:118px;height:118px;border-radius:16px;background:#0e0e10}
  .cell img{width:100%;height:100%;display:block;border-radius:16px}
  .cap{font-size:22px;color:#d4d4d8;margin:0;text-align:center;max-width:880px}
</style></head><body>${inner}</body></html>`;
const BRAND = `<div class="brand"><span class="jet">✈️</span><h1>Jet<span class="flame">stream</span></h1></div>`;

const assets = [
  { name: 'thumbnail.png', w: 640, h: 640, html: PAGE(`${BRAND}<p class="tag">Claude Code, live on your Stream Deck.</p>${deck(boardCells.slice(0, 5), 5)}`, 640, 640) },
  { name: 'gallery-1-board.png', w: 960, h: 540, html: PAGE(`<p class="cap">A live status board — working, needs you, done — for every project.</p>${deck(boardCells, 5)}`, 960, 540) },
  { name: 'gallery-2-controls.png', w: 960, h: 540, html: PAGE(`<p class="cap">A second page of controls: engine heartbeat, review queue, model, stop-all, launches.</p>${deck(opsCells, 5)}`, 960, 540) },
  { name: 'gallery-3-hero.png', w: 960, h: 540, html: PAGE(`${BRAND}<p class="tag">Status board · attention doorbell · usage gauge · launch keys · Stream Deck + dial.</p>${deck(boardCells.slice(0, 10), 5)}`, 960, 540) },
];

if (!existsSync(CHROME)) throw new Error('Google Chrome not found at ' + CHROME);
for (const a of assets) {
  const htmlFile = join(tmpdir(), `store-${a.name}.html`);
  writeFileSync(htmlFile, a.html);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=2', `--window-size=${a.w},${a.h}`, `--screenshot=${join(OUT, a.name)}`, pathToFileURL(htmlFile).href], { stdio: 'ignore' });
  console.log(`  ${a.name}  (${a.w * 2}×${a.h * 2}px)`);
  rmSync(htmlFile, { force: true });
}
console.log(`\nWrote to ${OUT}`);
