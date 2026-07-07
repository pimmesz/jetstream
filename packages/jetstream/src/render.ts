/** Pure SVG key faces. Everything (colour, label, sub-line) is baked into one image
 * so a key never mixes a stale title with a fresh face; callers `setTitle('')`. */

export interface Face {
  /** Background colour (`#rrggbb`). */
  color: string;
  /** Main label, e.g. the project name. Middle line, bold. */
  label: string;
  /** Smaller line under the label, e.g. `working 12m` or `5h 34%`. */
  sub?: string;
  /** Smaller line above the label, e.g. the model name. */
  top?: string;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Truncate to fit a 144px key face without overflowing. */
export function fit(text: string, max = 10): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Render a key face as a `data:image/svg+xml` URI for `setImage`. Pure. */
export function keyFace(face: Face): string {
  const label = esc(fit(face.label));
  const sub = face.sub === undefined ? '' : esc(fit(face.sub, 14));
  const top = face.top === undefined ? '' : esc(fit(face.top, 14));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<rect width="144" height="144" rx="18" fill="${esc(face.color)}"/>` +
    (top ? `<text x="72" y="42" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="18" fill="rgba(255,255,255,0.85)">${top}</text>` : '') +
    `<text x="72" y="82" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="26" font-weight="700" fill="#ffffff">${label}</text>` +
    (sub ? `<text x="72" y="112" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="18" fill="rgba(255,255,255,0.85)">${sub}</text>` : '') +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Compact elapsed time for a working key: `4m`, `1h12m`, `2h`. Minimum `1m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '1m';
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Countdown to an epoch-seconds reset: `2h14m`, `14m`, `3d`. Empty when unknown/past. */
export function formatReset(resetsAtSec: number | undefined, nowMs: number): string {
  if (resetsAtSec === undefined) return '';
  const ms = resetsAtSec * 1000 - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  if (d > 0) return `${d}d`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}
