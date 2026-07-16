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
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop';

const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
];

export interface HookEvent {
  event: HookEventName;
  cwd: string;
  sessionId: string;
  /** Epoch ms the event was observed (supplied by the caller, so this stays pure). */
  at: number;
  /** The tool being called, on a `PreToolUse` event (opt-in tool detail). */
  toolName?: string;
  /** The subagent's id, on a `SubagentStart`/`SubagentStop` event — fired in the PARENT session,
   * so this tracks which background agents are still running under it. */
  agentId?: string;
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
  const toolName = typeof r?.tool_name === 'string' ? r.tool_name : undefined;
  const agentId = typeof r?.agent_id === 'string' ? r.agent_id : undefined;
  return { event, cwd, sessionId, at, ...(toolName ? { toolName } : {}), ...(agentId ? { agentId } : {}) };
}

const norm = (p: string): string => p.replace(/\/+$/, '');

/** The id of the configured project whose path best (longest-prefix) contains `cwd`,
 * or undefined when none does. Longest-prefix so a nested project wins over its parent. */
export function matchProject(cwd: string, projects: ProjectConfig[]): string | undefined {
  const c = norm(cwd);
  let best: { id: string; len: number } | undefined;
  for (const p of projects) {
    // An unconfigured key (raw empty path) must match NOTHING — otherwise `''.startsWith`
    // logic makes it a prefix of every absolute cwd, scooping unrelated sessions into a
    // phantom board/fleet/attention entry. Guard the RAW value, not norm(): a real root
    // path like '/' is an intentional (if unusual) config and still matches.
    if (p.path === '') continue;
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
  /** The tool active during a `PreToolUse`→`PostToolUse` window (opt-in detail). */
  tool?: string;
  /** Ids of subagents still running under this session (SubagentStart without a matching Stop).
   * A non-empty set means background work is in flight, so the session reads 'working' even after
   * its main turn yielded (Stop → 'done'). In-memory only — dropped on checkpoint restore, since a
   * subagent that outlives a plugin restart is unknowable. */
  inflight?: string[];
}

export interface StatusState {
  sessions: Record<string, SessionState>;
}

export function initialState(): StatusState {
  return { sessions: {} };
}

/** The lifecycle events that map DIRECTLY to a status. Subagent start/stop are handled apart
 * (they move the in-flight set, not the base status). */
type LifecycleEvent = Exclude<HookEventName, 'SubagentStart' | 'SubagentStop'>;

function statusForEvent(event: LifecycleEvent): ProjectStatus | 'remove' {
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

/** Apply one hook event. `SessionEnd` forgets the session; a subagent event only updates the
 * in-flight set (a workflow/Task's background agents fire Start/Stop in the PARENT session);
 * every other event stamps the session's base status. Pure — returns a new state. */
export function reduce(state: StatusState, event: HookEvent): StatusState {
  const next: Record<string, SessionState> = { ...state.sessions };
  const prev = next[event.sessionId];

  if (event.event === 'SubagentStart' || event.event === 'SubagentStop') {
    // A SubagentStop for a session we don't know (its SessionEnd already fired, or it was lost
    // across a plugin restart) must NOT resurrect it — only a Start may seed a first-seen session.
    if (!prev && event.event === 'SubagentStop') return state;
    const inflight = new Set(prev?.inflight);
    if (event.agentId) {
      if (event.event === 'SubagentStart') inflight.add(event.agentId);
      else inflight.delete(event.agentId);
    }
    // Base status/cwd/since are the PARENT's — a subagent event never moves them; it only tracks
    // whether background work is still in flight. A first-seen session (no prior lifecycle event
    // reached this instance) starts 'working', since a running subagent means active work.
    next[event.sessionId] = {
      cwd: prev?.cwd ?? event.cwd,
      status: prev?.status ?? 'working',
      since: prev?.since ?? event.at,
      ...(prev?.tool ? { tool: prev.tool } : {}),
      ...(inflight.size ? { inflight: [...inflight] } : {}),
    };
    return { sessions: next };
  }

  const status = statusForEvent(event.event);
  if (status === 'remove') {
    delete next[event.sessionId]; // SessionEnd forgets the session AND its in-flight set
    return { sessions: next };
  }
  const session: SessionState = { cwd: event.cwd, status, since: event.at };
  // Show the tool only during its own PreToolUse→PostToolUse window; every other
  // working event (UserPromptSubmit / PostToolUse / Stop) leaves `tool` cleared.
  if (event.event === 'PreToolUse' && event.toolName) session.tool = event.toolName;
  // Carry in-flight subagents across a base-status change so a Stop that yields to a running workflow
  // stays 'working' — EXCEPT on UserPromptSubmit: a fresh user turn means the prior turn's agents are
  // no longer why the key is lit (the prompt itself stamps 'working'), and dropping them here
  // self-heals a lost SubagentStop instead of pinning the key 'working' for the rest of the session.
  if (event.event !== 'UserPromptSubmit' && prev?.inflight?.length) session.inflight = prev.inflight;
  next[event.sessionId] = session;
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
  /** The tool the dominant working session is running, when tool detail is enabled. */
  tool?: string;
}

/** How the board should read a session's status: a session with in-flight subagents (a running
 * workflow/Task) counts as at least 'working', even after its main turn yielded (Stop → 'done') —
 * otherwise a waiting workflow, whose process burns no CPU, would read as idle/done. Pure. */
function effectiveStatus(session: SessionState): ProjectStatus {
  if (session.inflight?.length && RANK[session.status] < RANK.working) return 'working';
  return session.status;
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
    const status = effectiveStatus(session);
    const current = acc[id] ?? { status: 'none' };
    const higher = RANK[status] > RANK[current.status];
    const sameEarlier =
      RANK[status] === RANK[current.status] &&
      (current.since === undefined || session.since < current.since);
    if (higher || sameEarlier) {
      acc[id] = {
        status,
        since: session.since,
        ...(session.tool ? { tool: session.tool } : {}),
      };
    }
  }
  return acc;
}

/** Project ids currently waiting on you (for a single "attention" key / doorbell). */
export function needsAttention(state: StatusState, projects: ProjectConfig[]): string[] {
  return Object.entries(statusByProject(state, projects))
    .filter(([, value]) => value.status === 'needsInput')
    .map(([id]) => id);
}

/** Live-work counts for the fleet roll-up key. `none` (no session) is ignored — the
 * roll-up answers "what's happening / is anything waiting on me". Pure. */
export interface FleetSummary {
  working: number;
  waiting: number;
  done: number;
  idle: number;
}

export function summarize(byProject: Record<string, ProjectState>): FleetSummary {
  const out: FleetSummary = { working: 0, waiting: 0, done: 0, idle: 0 };
  for (const { status } of Object.values(byProject)) {
    if (status === 'working') out.working += 1;
    else if (status === 'needsInput') out.waiting += 1;
    else if (status === 'done') out.done += 1;
    else if (status === 'idle') out.idle += 1;
  }
  return out;
}

/** The worst (highest-priority) status present across projects, for the roll-up key's
 * colour: needsInput > working > done > idle > none. Empty → 'none'. Pure. */
export function worstStatus(byProject: Record<string, ProjectState>): ProjectStatus {
  let worst: ProjectStatus = 'none';
  for (const { status } of Object.values(byProject)) {
    if (RANK[status] > RANK[worst]) worst = status;
  }
  return worst;
}

/** Colour theme. `highContrast` swaps the red/green pair (unsafe for red-green colour
 * blindness) for an orange/blue pair; glyphs (see `glyphFor`) make state legible in
 * either theme regardless of colour. */
export type Theme = 'default' | 'highContrast';

/** Key colour for a status. */
export function colorFor(status: ProjectStatus, theme: Theme = 'default'): string {
  if (theme === 'highContrast') {
    switch (status) {
      case 'working':
        return '#f76808'; // orange — busy
      case 'needsInput':
        return '#ffc53d'; // yellow — waiting on you
      case 'done':
        return '#0091ff'; // blue — finished (orange/blue is colour-blind-safe)
      case 'idle':
        return '#8e8e93'; // slate — session open
      case 'none':
        return '#3a3a3a'; // grey — no session
    }
  }
  switch (status) {
    case 'working':
      return '#f76808'; // orange — busy (red is reserved for danger: deny / stop / error / over-budget)
    case 'needsInput':
      return '#ffb224'; // amber — waiting on you
    case 'done':
      return '#30a46c'; // green — finished, ready to review
    case 'idle':
      return '#8e8e93'; // slate — session open, no active turn
    case 'none':
      return '#3a3a3a'; // grey — no session
  }
}

/** A shape glyph per status, so state is distinguishable WITHOUT colour (colour-blind
 * safe). Rendered on the key alongside the colour. */
export function glyphFor(status: ProjectStatus): string {
  switch (status) {
    case 'working':
      return '⋯';
    case 'needsInput':
      return '!';
    case 'done':
      return '✓';
    case 'idle':
      return '·';
    case 'none':
      return '';
  }
}

/** Whether an unacknowledged `needsInput` has waited long enough to escalate (flash).
 * Pure; `sinceMs` is when it started waiting. */
export function shouldEscalate(
  sinceMs: number | undefined,
  nowMs: number,
  thresholdMs: number,
): boolean {
  return sinceMs !== undefined && Number.isFinite(sinceMs) && nowMs - sinceMs >= thresholdMs;
}

export type {
  PermissionBehavior,
  PendingPermission,
} from './permission';
export { parsePermissionRequest, permissionDecisionJson, summarizeTool } from './permission';
