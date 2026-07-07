/**
 * Per-project Claude Code status, derived from lifecycle hooks.
 *
 * You cannot inspect a running Claude TUI from outside — but Claude Code hooks fire
 * during ANY session (interactive too) and can POST to a local server. Install these
 * hooks globally and every session in every project reports its lifecycle here; this
 * module reduces that stream into a colour per project for the Stream Deck board.
 */

/** The rendered state of a project key. */
export type ProjectStatus = 'none' | 'idle' | 'working' | 'needsInput' | 'done';

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd';

const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
];

export interface HookEvent {
  event: HookEventName;
  cwd: string;
  sessionId: string;
  /** Epoch ms the event was observed (supplied by the caller, so this stays pure). */
  at: number;
}

/** A configured project key: an id, a display name, and the filesystem path whose
 * Claude sessions colour it. */
export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isHookEvent(value: string): value is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** Parse the JSON a Claude Code hook pipes on stdin into a typed event, or null when
 * it isn't a usable hook payload. `at` is passed in so this stays pure/testable.
 * Payload carries `hook_event_name`, `cwd`, `session_id` (among others). */
export function parseHookPayload(raw: unknown, at: number): HookEvent | null {
  const r = asRecord(raw);
  const event = r?.hook_event_name;
  const cwd = r?.cwd;
  const sessionId = r?.session_id;
  if (typeof event !== 'string' || !isHookEvent(event)) return null;
  if (typeof cwd !== 'string' || typeof sessionId !== 'string') return null;
  return { event, cwd, sessionId, at };
}

const norm = (p: string): string => p.replace(/\/+$/, '');

/** The id of the configured project whose path best (longest-prefix) contains `cwd`,
 * or undefined when none does. Longest-prefix so a nested project wins over its parent. */
export function matchProject(cwd: string, projects: ProjectConfig[]): string | undefined {
  const c = norm(cwd);
  let best: { id: string; len: number } | undefined;
  for (const p of projects) {
    const base = norm(p.path);
    if (c === base || c.startsWith(`${base}/`)) {
      if (!best || base.length > best.len) best = { id: p.id, len: base.length };
    }
  }
  return best?.id;
}

interface SessionState {
  cwd: string;
  status: ProjectStatus;
  since: number;
}

export interface StatusState {
  sessions: Record<string, SessionState>;
}

export function initialState(): StatusState {
  return { sessions: {} };
}

function statusForEvent(event: HookEventName): ProjectStatus | 'remove' {
  switch (event) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working';
    case 'Notification':
      return 'needsInput';
    case 'Stop':
      return 'done';
    case 'SessionEnd':
      return 'remove';
  }
}

/** Apply one hook event. `SessionEnd` forgets the session; everything else stamps its
 * session's current status. Pure — returns a new state. */
export function reduce(state: StatusState, event: HookEvent): StatusState {
  const next: Record<string, SessionState> = { ...state.sessions };
  const status = statusForEvent(event.event);
  if (status === 'remove') {
    delete next[event.sessionId];
  } else {
    next[event.sessionId] = { cwd: event.cwd, status, since: event.at };
  }
  return { sessions: next };
}

const RANK: Record<ProjectStatus, number> = {
  needsInput: 4,
  working: 3,
  done: 2,
  idle: 1,
  none: 0,
};

export interface ProjectState {
  status: ProjectStatus;
  /** Epoch ms the dominant status began (e.g. when work started) — for an elapsed timer. */
  since?: number;
}

/** Collapse all live sessions into one status per configured project. A project takes
 * its highest-priority session (needsInput > working > done > idle), earliest `since`
 * within that status — so `working` shows how long it's been busy. Pure. */
export function statusByProject(
  state: StatusState,
  projects: ProjectConfig[],
): Record<string, ProjectState> {
  const acc: Record<string, ProjectState> = {};
  for (const p of projects) acc[p.id] = { status: 'none' };
  for (const session of Object.values(state.sessions)) {
    const id = matchProject(session.cwd, projects);
    if (id === undefined) continue;
    const current = acc[id] ?? { status: 'none' };
    const higher = RANK[session.status] > RANK[current.status];
    const sameEarlier =
      RANK[session.status] === RANK[current.status] &&
      (current.since === undefined || session.since < current.since);
    if (higher || sameEarlier) acc[id] = { status: session.status, since: session.since };
  }
  return acc;
}

/** Project ids currently waiting on you (for a single "attention" key / doorbell). */
export function needsAttention(state: StatusState, projects: ProjectConfig[]): string[] {
  return Object.entries(statusByProject(state, projects))
    .filter(([, value]) => value.status === 'needsInput')
    .map(([id]) => id);
}

/** Default key colour for a status (override in the plugin theme). */
export function colorFor(status: ProjectStatus): string {
  switch (status) {
    case 'working':
      return '#e5484d'; // red — Claude is busy
    case 'needsInput':
      return '#ffb224'; // amber — waiting on you
    case 'done':
      return '#30a46c'; // green — finished, ready to review
    case 'idle':
      return '#0091ff'; // blue — session open, no active turn
    case 'none':
      return '#3a3a3a'; // grey — no session
  }
}

export type {
  PermissionBehavior,
  PendingPermission,
} from './permission';
export { parsePermissionRequest, permissionDecisionJson, summarizeTool } from './permission';
