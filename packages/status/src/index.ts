/**
 * Per-project Claude Code status, derived from lifecycle hooks.
 *
 * You cannot inspect a running Claude TUI from outside — but Claude Code hooks fire
 * during ANY session (interactive too) and can POST to a local server. Install these
 * hooks globally and every session in every project reports its lifecycle here; this
 * module reduces that stream into a colour per project for the Stream Deck board.
 */

/** The rendered state of a project key. */
export type ProjectStatus = 'none' | 'idle' | 'working' | 'needsInput' | 'done' | 'failed';

export type HookEventName =
  | 'SessionStart'
  | 'StopFailure'
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
  'StopFailure',
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
  // The /hook endpoint is unauthenticated, so these two are untrusted and become MAP KEYS +
  // persisted state. Anything past a sane path/uuid length is not a real payload — reject it here
  // rather than let it pin memory and disk (see SESSION_CAP below for the count bound).
  if (cwd.length > MAX_CWD_LEN || sessionId.length > MAX_SESSION_ID_LEN) return null;
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

/** One running subagent under a session: its id and when it started. The timestamp is the
 * self-heal: hook delivery is fire-and-forget, so a lost SubagentStop would otherwise pin the
 * session 'working' forever — instead, entries older than INFLIGHT_TTL_MS stop counting. */
export interface InflightAgent {
  id: string;
  at: number;
}

/** How long a subagent entry keeps a session 'working' without its SubagentStop arriving.
 * Long enough for a real workflow's agents (they run tens of minutes); short enough that a
 * dropped Stop hook can't pin a key orange for a whole session. Accepted trade: an agent that
 * stays FULLY quiet (0% CPU) past the TTL reads done/idle until it computes again — the CPU
 * sustained-active fallback only recovers agents that are actually burning cycles. */
export const INFLIGHT_TTL_MS = 30 * 60_000;

interface SessionState {
  cwd: string;
  status: ProjectStatus;
  since: number;
  /** The tool active during a `PreToolUse`→`PostToolUse` window (opt-in detail). */
  tool?: string;
  /** Subagents still running under this session (SubagentStart without a matching Stop).
   * Live entries mean background work is in flight, so the session reads 'working' even after
   * its main turn yielded (Stop → 'done'). In-memory only — dropped on checkpoint restore, since
   * a subagent that outlives a plugin restart is unknowable. */
  inflight?: InflightAgent[];
  /** Tombstones for SubagentStops that arrived BEFORE their Start (hook POSTs are independent
   * processes with no ordering guarantee): the late Start cancels against its tombstone instead
   * of planting an entry whose Stop already came and went. Same TTL hygiene as inflight. */
  stopped?: InflightAgent[];
}

export interface StatusState {
  sessions: Record<string, SessionState>;
  /** Ids of sessions a `SessionEnd` removed, each with when — a tombstone so a straggler hook
   * (a reordered POST that lands AFTER the SessionEnd) can't re-create a session that no future
   * SessionEnd will ever clear. TTL-pruned + capped; in-memory best-effort (dropped on restore). */
  ended?: InflightAgent[];
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
    // A turn killed by the API (overloaded / rate_limit / billing_error / authentication_failed)
    // fires StopFailure and NOT Stop — without this the session stays pinned 'working' until the
    // stall glyph or the PID reaper gives up, i.e. the board cannot tell finished from died.
    case 'StopFailure':
      return 'failed';
    case 'SessionEnd':
      return 'remove';
  }
}

/** Apply one hook event. `SessionEnd` forgets the session; a subagent event only updates the
 * in-flight set (a workflow/Task's background agents fire Start/Stop in the PARENT session);
 * every other event stamps the session's base status. Pure — returns a new state. */
/** Bounds on the untrusted `/hook` payload. A real cwd is a filesystem path and a real session id
 * is a uuid; these are generous ceilings, not format checks. */
const MAX_CWD_LEN = 4096;
const MAX_SESSION_ID_LEN = 128;
/** Max concurrent sessions kept. `sessions` is keyed by an attacker-suppliable session_id and is
 * serialized to disk, so — like its `ended`/`stopped`/`inflight` siblings — it must be bounded.
 * Far above any real fleet; on overflow the oldest-started session is evicted. */
const SESSION_CAP = 256;

/** Drop the oldest-started sessions until the map is within SESSION_CAP. Mutates `sessions`. */
function capSessions(sessions: Record<string, ProjectState>): void {
  const ids = Object.keys(sessions);
  if (ids.length <= SESSION_CAP) return;
  const oldestFirst = ids.sort((a, b) => (sessions[a]?.since ?? 0) - (sessions[b]?.since ?? 0));
  for (const id of oldestFirst.slice(0, ids.length - SESSION_CAP)) delete sessions[id];
}

export function reduce(state: StatusState, event: HookEvent): StatusState {
  const next: Record<string, SessionState> = { ...state.sessions };
  const prev = next[event.sessionId];

  // Tombstone guard: once a SessionEnd removes a session, its id is dead — Claude session ids are
  // unique and never reused — so a later event for it is a straggler from reordered, independent
  // hook POSTs. Reducing it would re-create a ghost key that no future SessionEnd will ever clear.
  // Presence (not `at` order) is what's decisive here; `at` only ages the tombstone out so the
  // list stays bounded. A duplicate SessionEnd is a harmless no-op, so it needn't be exempted.
  if (state.ended?.some((t) => t.id === event.sessionId && event.at - t.at < INFLIGHT_TTL_MS)) {
    return state;
  }

  if (event.event === 'SubagentStart' || event.event === 'SubagentStop') {
    // A SubagentStop for a session we don't know (its SessionEnd already fired, or it was lost
    // across a plugin restart) must NOT resurrect it — only a Start may seed a first-seen session.
    if (!prev && event.event === 'SubagentStop') return state;
    // Prune both lists by TTL as they pass through — bounded state, pure (event time, not wall clock).
    const fresh = (a: InflightAgent): boolean => event.at - a.at < INFLIGHT_TTL_MS;
    let inflight = (prev?.inflight ?? []).filter(fresh);
    let stopped = (prev?.stopped ?? []).filter(fresh);
    if (event.agentId) {
      const id = event.agentId;
      if (event.event === 'SubagentStart') {
        if (stopped.some((a) => a.id === id)) {
          // This agent's Stop was delivered FIRST (unordered POSTs) — cancel the pair instead
          // of planting an entry whose Stop already came and went.
          stopped = stopped.filter((a) => a.id !== id);
        } else {
          // A duplicate Start refreshes its timestamp instead of double-counting.
          inflight = [...inflight.filter((a) => a.id !== id), { id, at: event.at }];
        }
      } else {
        const had = inflight.some((a) => a.id === id);
        inflight = inflight.filter((a) => a.id !== id);
        // An unmatched Stop tombstones its id so a late-arriving Start cancels against it
        // (bounded — a session never legitimately accumulates many of these).
        if (!had) stopped = [...stopped.filter((a) => a.id !== id), { id, at: event.at }].slice(-16);
      }
    }
    // Base status/cwd/since are the PARENT's — a subagent event never moves them. A first-seen
    // session seeds 'idle': the LIVE inflight entry is what reads as 'working' (effectiveStatus),
    // so when the agent stops or ages out the key settles instead of pinning orange forever.
    next[event.sessionId] = {
      cwd: prev?.cwd ?? event.cwd,
      status: prev?.status ?? 'idle',
      since: prev?.since ?? event.at,
      ...(prev?.tool ? { tool: prev.tool } : {}),
      ...(inflight.length ? { inflight } : {}),
      ...(stopped.length ? { stopped } : {}),
    };
    return { sessions: next, ...(state.ended ? { ended: state.ended } : {}) };
  }

  const status = statusForEvent(event.event);
  if (status === 'remove') {
    delete next[event.sessionId]; // SessionEnd forgets the session AND its in-flight set
    // Tombstone the id (TTL-pruned + capped at 64) so a reordered straggler can't resurrect it.
    const ended = [
      ...(state.ended ?? []).filter((t) => t.id !== event.sessionId && event.at - t.at < INFLIGHT_TTL_MS),
      { id: event.sessionId, at: event.at },
    ].slice(-64);
    return { sessions: next, ended };
  }
  const session: SessionState = { cwd: event.cwd, status, since: event.at };
  // Show the tool only during its own PreToolUse→PostToolUse window; every other
  // working event (UserPromptSubmit / PostToolUse / Stop) leaves `tool` cleared.
  if (event.event === 'PreToolUse' && event.toolName) session.tool = event.toolName;
  // Carry in-flight subagents (and Stop tombstones) across EVERY base-status change: a Stop that
  // yields to a running workflow stays 'working', and a NEW user turn doesn't forget a workflow
  // still running from the previous one. A lost SubagentStop can't pin the key forever — entries
  // age out after INFLIGHT_TTL_MS (see effectiveStatus), the self-heal a hard clear used to provide.
  if (prev?.inflight?.length) session.inflight = prev.inflight;
  if (prev?.stopped?.length) session.stopped = prev.stopped;
  next[event.sessionId] = session;
  capSessions(next); // untrusted key → bound the map (and therefore the persisted state)
  return { sessions: next, ...(state.ended ? { ended: state.ended } : {}) };
}

const RANK: Record<ProjectStatus, number> = {
  needsInput: 5,
  failed: 4, // a died turn outranks a running/finished one — it needs you, but isn't blocking a prompt
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

/** How the board should read a session's status: a session with LIVE in-flight subagents (a
 * running workflow/Task) counts as at least 'working', even after its main turn yielded
 * (Stop → 'done') — otherwise a waiting workflow, whose process burns no CPU, would read as
 * idle/done. Entries older than INFLIGHT_TTL_MS are ignored, so a lost SubagentStop self-heals
 * instead of pinning the key. Pure — `now` is supplied by the caller. */
function effectiveStatus(session: SessionState, now: number): ProjectStatus {
  const live = session.inflight?.some((a) => now - a.at < INFLIGHT_TTL_MS);
  if (live && RANK[session.status] < RANK.working) return 'working';
  return session.status;
}

/** Collapse all live sessions into one status per configured project. A project takes
 * its highest-priority session (needsInput > working > done > idle), earliest `since`
 * within that status — so `working` shows how long it's been busy. Pure given `now`
 * (used only to age out stale in-flight subagents). */
export function statusByProject(
  state: StatusState,
  projects: ProjectConfig[],
  now: number = Date.now(),
): Record<string, ProjectState> {
  const acc: Record<string, ProjectState> = {};
  for (const p of projects) acc[p.id] = { status: 'none' };
  for (const session of Object.values(state.sessions)) {
    const id = matchProject(session.cwd, projects);
    if (id === undefined) continue;
    const status = effectiveStatus(session, now);
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
    // 'failed' rings too: a turn the API killed needs you just as much as one waiting at a
    // prompt — and unlike needsInput, nothing else will ever surface it.
    .filter(([, value]) => value.status === 'needsInput' || value.status === 'failed')
    // RANKED, not config order. The doorbell shows and jumps to the HEAD of this list, so with a
    // mixed set the order decides which project you are sent to — and a blocking prompt outranks a
    // died turn (RANK: needsInput 5 > failed 4). Ties break on age, oldest first: whoever has been
    // waiting longest. Before 'failed' existed the set was homogeneous and any order was correct.
    .sort(([, a], [, b]) => RANK[b.status] - RANK[a.status] || (a.since ?? 0) - (b.since ?? 0))
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
    // A failed turn counts as waiting-on-you: it must not vanish from the roll-up, and the
    // fleet key's colour already distinguishes it (worstStatus ranks 'failed' above 'working').
    else if (status === 'needsInput' || status === 'failed') out.waiting += 1;
    else if (status === 'done') out.done += 1;
    else if (status === 'idle') out.idle += 1;
  }
  return out;
}

/** The worst (highest-priority) status present across projects, for the roll-up key's
 * colour: needsInput > failed > working > done > idle > none. Empty → 'none'. Pure. */
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
      case 'failed':
        return '#d6409f'; // magenta — distinct from the amber/orange pair under colour-blindness
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
    case 'failed':
      return '#d6409f'; // magenta — a turn that DIED, deliberately not the working orange or the
    // danger red reserved for deny/stop; distinguishable from both under colour-blindness
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
    case 'failed':
      return '✕';
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
