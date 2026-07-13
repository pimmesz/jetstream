/** Colour names people actually say, mapped to the deck's palette hexes. Extend freely. */
const COLOR_NAMES: Record<string, string> = {
  red: '#e5484d',
  green: '#30a46c',
  'spotify-green': '#1db954',
  blue: '#0091ff',
  yellow: '#f5a623',
  amber: '#f5a623',
  orange: '#e85d2f',
  purple: '#7c5cff',
  pink: '#d6409f',
  teal: '#12a594',
  charcoal: '#26262b',
  slate: '#4a4a52',
  grey: '#4a4a52',
  gray: '#4a4a52',
  white: '#f5f5f7',
  black: '#161618',
};

/** Canonical `#rrggbb` from a hex (3- or 6-digit) or a known colour name, or undefined when it's
 * neither (the caller then drops the field rather than paint a bad colour). Pure. */
export function normalizeColor(value: string): string | undefined {
  const t = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${[...t.slice(1)].map((c) => c + c).join('')}`;
  return COLOR_NAMES[t.replace(/\s+/g, '-')];
}
