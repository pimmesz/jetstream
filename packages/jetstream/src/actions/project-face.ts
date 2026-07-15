import { colorFor, glyphFor, type ProjectStatus } from '@pimmesz/jetstream-status';
import type { Face } from '../render';
import { formatElapsed } from '../render';
import { formatDiffStat, type DiffStat } from '../diffstat';

/** The theme argument `colorFor` takes — derived so this module needs no config import. */
type Theme = Parameters<typeof colorFor>[1];

const STATUS_LABEL: Record<string, string> = {
  none: '',
  idle: 'idle',
  working: 'working',
  needsInput: 'NEEDS YOU',
  done: 'done',
};

export interface ProjectFaceInput {
  /** Display name (a rename override wins upstream; here it's just the text). */
  name: string;
  /** Has a repo path — an unconfigured key shows a dark "set path" placeholder. */
  configured: boolean;
  status: ProjectStatus;
  since?: number;
  tool?: string;
  /** The needsInput can be answered from the deck (a held permission) → `!`; else `?`. */
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
  if (!i.configured) return { color: '#26262b', label: i.name, subMax: 20, sub: 'set path' };
  return {
    color: colorFor(i.status, i.theme),
    label: i.name,
    subMax: 20, // room for the diff badge (`+120/-40 · done 4m`)
    glyph: projectGlyph(i.status, i.answerable),
    ...projectSub(i),
  };
}

/** A needsInput project the deck CAN answer (a held permission) shows `!`; one it can't (an open
 * elicitation → go to the keyboard) shows `?`. Otherwise the status glyph. */
function projectGlyph(status: ProjectStatus, answerable: boolean): string {
  if (status === 'needsInput') return answerable ? '!' : '?';
  return glyphFor(status);
}

/** The line under the label: `Bash · 12m` (working), `+120/-40 · done 4m` (finished), `approve?` /
 * `answer` (needs you — deck-answerable or not), or the plain status word. */
function projectSub(i: ProjectFaceInput): { sub: string } | Record<string, never> {
  if (i.status === 'needsInput') return { sub: i.answerable ? 'approve?' : 'answer' };
  const elapsed = i.since !== undefined ? formatElapsed(i.now - i.since) : '';
  if (i.status === 'working' && elapsed) {
    return { sub: i.tool ? `${i.tool} · ${elapsed}` : `working ${elapsed}` };
  }
  if (i.status === 'done' && elapsed) {
    const badge = formatDiffStat(i.diffStat);
    return { sub: badge ? `${badge} · done ${elapsed}` : `done ${elapsed}` };
  }
  const label = STATUS_LABEL[i.status] ?? '';
  return label ? { sub: label } : {};
}
