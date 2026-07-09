import { colorFor, type ProjectStatus, type Theme } from '@pimmesz/jetstream-status';
import { formatElapsed } from './render';

/**
 * Pure logic for the Fleet dial (Stream Deck + encoder). The action itself is thin SDK
 * glue; everything testable lives here.
 */

/** Wrap-around index scrub: a rotate of `ticks` moves the selected index, wrapping at both
 * ends (clockwise past the last returns to the first, and vice-versa). An empty fleet
 * (`len <= 0`) always resolves to 0 so callers never index out of range. */
export function scrubIndex(len: number, current: number, ticks: number): number {
  if (len <= 0) return 0;
  return (((current + ticks) % len) + len) % len;
}

export interface DialFeedback {
  /** Top line — the selected project's name. */
  title: string;
  /** Bottom line — its live status. */
  value: string;
  /** Colour of the status line, matching the board's colour for that status. */
  color: string;
}

interface DialState {
  status: ProjectStatus;
  since?: number;
  tool?: string;
}

/** The touchscreen content for the dial's currently-selected project: name on top, a
 * coloured live-status line below. A missing project (empty fleet) shows an invitation. */
export function dialFeedback(
  project: { name: string } | undefined,
  state: DialState,
  now: number,
  theme: Theme = 'default',
): DialFeedback {
  if (!project) {
    return { title: 'Fleet', value: 'add repos in settings', color: '#8a8a8a' };
  }
  return { title: project.name, value: statusLine(state, now), color: colorFor(state.status, theme) };
}

/** `needs you`, `Bash · 12m` (working), `done 4m`, `idle`, or `—` — mirrors the wording of
 * the keypad Project face without its diff badge (no room on one dial line). */
function statusLine(state: DialState, now: number): string {
  const elapsed = state.since !== undefined ? formatElapsed(now - state.since) : '';
  switch (state.status) {
    case 'needsInput':
      return 'needs you';
    case 'working':
      return state.tool ? `${state.tool} · ${elapsed}` : elapsed ? `working ${elapsed}` : 'working';
    case 'done':
      return elapsed ? `done ${elapsed}` : 'done';
    case 'idle':
      return 'idle';
    default:
      return '—';
  }
}
