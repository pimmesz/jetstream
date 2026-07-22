import { colorFor, glyphFor, type ProjectStatus } from '@pimmesz/jetstream-status';
import type { Face } from '../render';
import { formatElapsed } from '../render';
import { formatDiffStat, type DiffStat } from '../diffstat';

/** The theme argument `colorFor` takes — derived so this module needs no config import. */
type Theme = Parameters<typeof colorFor>[1];

// Keyed by ProjectStatus, not `string`, so a new status can't silently fall through to a blank
// sub-line — which is exactly how 'failed' would have shipped as a coloured key with no words on it.
const STATUS_LABEL: Record<ProjectStatus, string> = {
  none: '',
  idle: 'idle',
  working: 'working',
  needsInput: 'NEEDS YOU',
  done: 'done',
  failed: 'FAILED',
};

/** A key that's shown 'working' this long with no hook update is likely a hung or abandoned turn
 * (a lost Stop hook, a wedged tool call) rather than genuine long work — flag it so the board
 * doesn't read a dead-in-the-water session as confidently busy. A fixed threshold, not a user
 * setting: it's deliberately long so real long-running work almost never trips it, and it keeps
 * this pure face free of a config dependency. The dead-PROCESS case is handled separately by the
 * board's session reaper; this covers the alive-but-silent one. */
const STALL_MS = 20 * 60_000;
/** Warning marker for a stalled key. U+FE0E forces text (monochrome) presentation so it stays a
 * plain white glyph like the others, not a colour emoji. */
const STALL_GLYPH = '⚠︎';

function isStalled(i: ProjectFaceInput): boolean {
  return i.status === 'working' && i.since !== undefined && i.now - i.since >= STALL_MS;
}

export interface ProjectFaceInput {
  /** Display name (a rename override wins upstream; here it's just the text). */
  name: string;
  /** Has a repo path — an unconfigured key shows a dark "set path" placeholder. */
  configured: boolean;
  status: ProjectStatus;
  since?: number;
  tool?: string;
  /** The needsInput can be answered from the deck (a held permission) → the sub-line reads
   * `approve on deck`; otherwise `answer in Claude`. Wording only — neither carries a glyph. */
  answerable: boolean;
  /** The done-episode diff badge, or null while unknown / not done. */
  diffStat: DiffStat | null;
  now: number;
  theme: Theme;
}

/**
 * The face for a project/repo key — the SINGLE source of truth shared by the standalone `ProjectKey`
 * action and the folded `project` slot kind, so the two status renderers can never drift. Pure: no
 * board reads, no side effects; the caller resolves status/diff/answerable and passes them in.
 */
export function projectFace(i: ProjectFaceInput): Face {
  if (!i.configured) return { color: '#26262b', label: i.name, subMax: 16, sub: 'set path' };
  const stalled = isStalled(i);
  const sub = projectSub(i, stalled);
  const glyph = projectGlyph(i, stalled);
  return {
    color: colorFor(i.status, i.theme),
    label: i.name,
    // Long lines (the diff badge, a tool name) need the room; everything else gets the LARGER
    // 18px sub instead (render.ts picks the font from subMax). The sub-line is the only
    // colour-independent channel on a key seen from across a room, so a short one should not be
    // shrunk to fit a width it never uses.
    subMax: (sub.sub?.length ?? 0) > 16 ? 20 : 16,
    ...(glyph ? { glyph } : {}),
    ...sub,
  };
}

/**
 * The corner marker — reserved for EXCEPTIONS, not decoration.
 *
 * It used to carry the status on every key, which duplicated the sub-line word for word: `✓` over
 * `done 4m`, `?` over `answer`, `⋯` over `working 1m`. Text is already colour-independent, so the
 * accessibility case the glyph existed for was being made twice while the corner — the one free
 * spot on the key — said nothing new. Leaving it EMPTY on ordinary states is what gives it meaning:
 * a marked key is now genuinely worth looking at.
 *
 * It survives in exactly two cases: a stall or a failure (redundancy is right for an alarm), and a
 * working key showing its tool, where the sub-line says `Bash · 12m` and nothing else says "working".
 */
function projectGlyph(i: ProjectFaceInput, stalled: boolean): string | undefined {
  if (stalled) return STALL_GLYPH;
  if (i.status === 'failed') return glyphFor('failed');
  if (i.status === 'working' && i.tool && i.since !== undefined) return glyphFor('working');
  return undefined;
}

/** The line under the label: `Bash · 12m` (working), `done 4m · +120/-40` (finished), `failed 4m` (a died turn),
 * `approve on deck` / `answer in Claude` (needs you — deck-answerable or not), or the plain status word. */
function projectSub(i: ProjectFaceInput, stalled: boolean): { sub: string } | Record<string, never> {
  // Name the place, not just the mood. `answer` never said where, and `approve?` read as though
  // pressing THIS key approves — it does not; the separate Approve key does.
  if (i.status === 'needsInput') return { sub: i.answerable ? 'approve on deck' : 'answer in Claude' };
  const elapsed = i.since !== undefined ? formatElapsed(i.now - i.since) : '';
  if (i.status === 'working' && elapsed) {
    if (stalled) return { sub: `stalled? ${elapsed}` };
    return { sub: i.tool ? `${i.tool} · ${elapsed}` : `working ${elapsed}` };
  }
  if (i.status === 'done' && elapsed) {
    // Status word FIRST, badge second. The badge is variable-width and unbounded (a big refactor
    // gives `+12000/-4000`), so with the badge leading, `fit()` truncated the trailing `done …`
    // away — and now that ordinary keys carry no corner glyph, colour would be the only thing left
    // saying "done". Leading with the word makes that structurally impossible: truncation can only
    // ever eat digits.
    const badge = formatDiffStat(i.diffStat);
    return { sub: badge ? `done ${elapsed} · ${badge}` : `done ${elapsed}` };
  }
  // A died turn carries WHEN it died, like the other timed states — "failed 4m" tells you whether
  // to retry now or that you missed it an hour ago.
  if (i.status === 'failed' && elapsed) return { sub: `failed ${elapsed}` };
  const label = STATUS_LABEL[i.status] ?? '';
  return label ? { sub: label } : {};
}
