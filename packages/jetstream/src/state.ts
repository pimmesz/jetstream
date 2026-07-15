import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  initialState,
  reduce,
  statusByProject,
  needsAttention,
  matchProject,
  type HookEvent,
  type ProjectConfig,
  type ProjectState,
  type ProjectStatus,
  type StatusState,
} from '@pimmesz/jetstream-status';
import { discoverClaudeSessions, type DiscoveredSession } from './discover';

export interface ProjectEntry {
  name: string;
  path: string;
}

/** Where the live board is checkpointed so a plugin/app restart doesn't blank the deck.
 * A small JSON in the user's home; a failed read/write is always non-fatal. */
const STATE_FILE = join(homedir(), '.jetstream', 'board-state.json');

/**
 * The plugin-wide board: the hook-event status state + the project registry. Each visible
 * Project key registers by its Stream Deck action id (which doubles as the ProjectConfig
 * id); the optional `projects.json` additionally SEEDS a baseline registry so the Fleet
 * roll-up and Attention doorbell cover the whole fleet even for repos without a placed key.
 * Placed keys override/add by id (deck wins in `projects()`).
 */
export class Board {
  private state: StatusState = initialState();
  private registry = new Map<string, ProjectEntry>();
  private seeded = new Map<string, ProjectEntry>();
  private sessions = new Map<string, { pid: number; cwd: string }>();
  private discovered: DiscoveredSession[] = [];
  // Epoch ms each discovered cwd FIRST read CPU-active (reset when it goes quiet). A resting
  // hook status (done / needsInput / idle) is only upgraded to 'working' once a cwd has been
  // SUSTAINED-active — a real background task (a Claude workflow keeps subagent processes busy
  // at the repo's cwd) reads as working, while a just-stopped session's decaying CPU can't
  // flicker a genuine 'done' back. See byProject / setDiscovered.
  private activeSince = new Map<string, number>();
  /** How long a cwd must stay continuously CPU-active before a resting hook status upgrades to
   * 'working' (≈2+ of the 5s discovery polls) — long enough to outlast a post-Stop CPU decay. */
  private static readonly SUSTAINED_ACTIVE_MS = 12_000;
  private listeners = new Set<() => void>();
  // While restore()'s async scan is in flight the hook server is already listening, so live
  // events keep arriving. Record which SESSIONS those events touch (see dispatch) so the
  // checkpoint merge can't resurrect a session the live board has since moved on from — most
  // importantly one a live SessionEnd removed mid-scan (which leaves no trace to override).
  private restoring = false;
  private touchedSessions = new Set<string>();
  /** Trailing-debounce handle: a busy fleet fires many hook events/sec, so the checkpoint write is
   * coalesced to one atomic write shortly after the last change rather than a blocking sync write
   * on the event path. */
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  /** Checkpoint file; injectable so tests don't touch the real home. */
  constructor(private readonly statePath: string = STATE_FILE) {}

  /** Seed the baseline registry from the config file (`projects.json`), keyed by each
   * entry's own id. Called once at startup, before any key registers, so the fleet is
   * visible without a placed key per repo. A placed Project key still overrides/adds by id. */
  seed(configs: ProjectConfig[]): void {
    this.seeded = new Map(configs.map((c) => [c.id, { name: c.name, path: c.path }]));
    this.emit();
  }

  dispatch(event: HookEvent): void {
    this.state = reduce(this.state, event);
    if (event.event === 'SessionEnd') this.sessions.delete(event.sessionId);
    if (this.restoring) this.touchedSessions.add(event.sessionId);
    this.persist();
    this.emit();
  }

  /** Remember a session's process (the hook's parent PID) so interrupt can SIGINT it —
   * and so a restart can reconcile persisted state against live processes. */
  notePid(sessionId: string, pid: number, cwd: string): void {
    if (sessionId && Number.isInteger(pid) && pid > 1) {
      this.sessions.set(sessionId, { pid, cwd });
      this.persist();
    }
  }

  /**
   * Restore the last checkpoint across a plugin/app restart, but drop any session whose
   * process is no longer alive — so a genuinely-running session re-shows immediately while a
   * finished one stays gray (no resurrected "working"). `isAlive` is injectable for tests.
   * Best-effort: a missing/corrupt file just leaves the board empty. Call once at startup.
   */
  async restore(
    discover: () => Promise<DiscoveredSession[]> = discoverClaudeSessions,
  ): Promise<void> {
    let rawSessions: Record<string, unknown>;
    try {
      if (!existsSync(this.statePath)) return;
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as { state?: { sessions?: unknown } };
      const sessions = parsed.state?.sessions;
      // Validate the shape INSIDE the try: a corrupt/partial checkpoint must never crash startup.
      if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return;
      rawSessions = sessions as Record<string, unknown>;
    } catch {
      return; // unreadable / invalid JSON → start fresh
    }
    // Reconcile against ACTUALLY-running Claude processes by working directory — robust to PID
    // reuse (a dead session's recycled PID can't resurrect it), attaching the LIVE pid so
    // interrupt targets the real process. Discovery failure → restore nothing (the poller
    // refills within a few seconds).
    this.restoring = true;
    this.touchedSessions.clear();
    let livePidByCwd: Map<string, number>;
    try {
      livePidByCwd = new Map((await discover()).map((session) => [session.cwd, session.pid]));
    } catch {
      this.restoring = false;
      return;
    }
    // Validate each persisted session (defensive against a corrupt checkpoint) and group by cwd.
    // Restore a cwd only when it has a live process AND exactly ONE persisted session — an
    // ambiguous cwd (two sessions in one repo, one now dead) can't be resolved from cwd alone,
    // so leave it to hooks/discovery rather than risk resurrecting the dead one's status.
    type Sess = StatusState['sessions'][string];
    const VALID: ReadonlySet<string> = new Set(['none', 'idle', 'working', 'needsInput', 'done']);
    const byCwd = new Map<string, Array<[string, Sess]>>();
    for (const [sessionId, value] of Object.entries(rawSessions)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as { cwd?: unknown; status?: unknown; since?: unknown; tool?: unknown };
      if (
        typeof v.cwd !== 'string' ||
        typeof v.since !== 'number' ||
        typeof v.status !== 'string' ||
        !VALID.has(v.status)
      ) {
        continue;
      }
      const session: Sess = {
        cwd: v.cwd,
        status: v.status as ProjectStatus,
        since: v.since,
        ...(typeof v.tool === 'string' ? { tool: v.tool } : {}),
      };
      const list = byCwd.get(v.cwd) ?? [];
      list.push([sessionId, session]);
      byCwd.set(v.cwd, list);
    }
    const restored: StatusState['sessions'] = {};
    const pids = new Map<string, { pid: number; cwd: string }>();
    for (const [cwd, sessions] of byCwd) {
      const livePid = livePidByCwd.get(cwd);
      if (livePid === undefined || sessions.length !== 1) continue; // no live proc, or ambiguous
      const [sessionId, session] = sessions[0]!;
      // A live hook for THIS session landed during the scan — the live board's view of it (a
      // status change, or a SessionEnd that removed it) is newer than the checkpoint, so don't
      // resurrect the persisted copy or its now-stale PID. Keyed on session id, not cwd: a
      // DIFFERENT live session in the same repo can't tell us whether this one is still alive,
      // so suppressing on cwd could hide a still-blocked session (see the merge note).
      if (this.touchedSessions.has(sessionId)) continue;
      restored[sessionId] = session;
      pids.set(sessionId, { pid: livePid, cwd });
    }
    this.restoring = false;
    // Merge, don't replace: real hook events can arrive during the async discovery scan
    // (dispatch() updates this.state / this.sessions while discover() runs) and are newer than
    // the checkpoint — so live state wins (spread last), and any session the scan touched was
    // dropped from `restored` above so a live SessionEnd isn't undone. NOT resolved (left to the
    // 5s poller): a checkpoint session for a repo where a *different-id* live session appears
    // mid-scan — cwd alone can't tell "ended + replaced" from "two concurrent sessions", so we
    // keep both rather than risk hiding a still-live one.
    this.state = { sessions: { ...restored, ...this.state.sessions } };
    this.sessions = new Map([...pids, ...this.sessions]);
    this.emit();
  }

  /** Checkpoint the live board (status + session PIDs). Best-effort — a write failure must
   * never break event handling. */
  private persist(): void {
    // Coalesce a burst of events into ONE write ~250ms after the last change. The timer reads the
    // latest state when it fires, so nothing is lost; while one is pending, further calls no-op.
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.writeCheckpoint();
    }, 250);
    this.persistTimer.unref?.(); // never keep the process alive just to flush the checkpoint
  }

  /** Force any pending debounced checkpoint to disk right now (a clean-shutdown path could call this;
   * tests use it to observe the checkpoint synchronously). */
  flush(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.writeCheckpoint();
  }

  private writeCheckpoint(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ state: this.state, sessions: [...this.sessions.entries()] }));
      renameSync(tmp, this.statePath); // atomic swap — a crash mid-write can't truncate the live checkpoint
    } catch {
      /* disk full / read-only home / … — the board stays correct in memory */
    }
  }

  /** PIDs of the sessions running under a given project key (for interrupt). */
  pidsForProject(actionId: string): number[] {
    const projects = this.projects();
    return [...this.sessions.values()]
      .filter((s) => matchProject(s.cwd, projects) === actionId)
      .map((s) => s.pid);
  }

  /** Every known session PID across the whole fleet (for the interrupt-all panic key). */
  allPids(): number[] {
    return [...this.sessions.values()].map((s) => s.pid);
  }

  setProject(actionId: string, entry: ProjectEntry): void {
    this.registry.set(actionId, entry);
    this.emit();
  }

  removeProject(actionId: string): void {
    this.registry.delete(actionId);
    this.emit();
  }

  project(actionId: string): ProjectEntry | undefined {
    return this.registry.get(actionId);
  }

  projects(): ProjectConfig[] {
    // A seed (projects.json) only covers repos WITHOUT a placed deck key. If a placed key
    // already owns a repo's PATH, keeping the seed too would list the same repo under two ids
    // (the seed's config id AND the key's action id) — a live session matches the seed's id
    // while the key renders by its OWN action id, so the key blanks to gray. Suppress any seed
    // whose path a placed key already claims; seeds still cover keyless repos for the Fleet /
    // Attention roll-ups. (Placed keys sharing a seed's id still override by id, as before.)
    // Ignore trailing slashes; keep an all-slash path as root '/', a relative '' as ''.
    const normPath = (p: string): string => p.replace(/\/+$/, '') || (p.startsWith('/') ? '/' : p);
    const placedPaths = new Set(
      [...this.registry.values()].map((e) => normPath(e.path)).filter((p) => p !== ''),
    );
    const merged = new Map<string, ProjectEntry>();
    for (const [id, entry] of this.seeded) {
      if (!placedPaths.has(normPath(entry.path))) merged.set(id, entry);
    }
    for (const [id, entry] of this.registry) merged.set(id, entry);
    return [...merged.entries()].map(([id, p]) => ({ id, name: p.name, path: p.path }));
  }

  /** Replace the set of running Claude sessions found by process scan (not by hooks). Lets a
   * project show as active even when no hook event reached this plugin instance — e.g. a
   * session already mid-work when the plugin (re)started. */
  setDiscovered(sessions: DiscoveredSession[], now = Date.now()): void {
    // Remember when each cwd FIRST read active (preserved across identical polls, dropped when it
    // goes quiet) so byProject can tell a SUSTAINED-busy repo from a brief post-Stop CPU spike.
    const active = new Map<string, number>();
    for (const s of sessions) {
      if (s.active) active.set(s.cwd, this.activeSince.get(s.cwd) ?? now);
    }
    this.activeSince = active;
    // Skip the repaint when the scan is unchanged — the poller fires every 5s and each emit
    // re-renders every key (SVG rebuild + setImage over the deck socket) and would also wipe a
    // Project key's in-flight "release to interrupt" warning. (activeSince advances above
    // regardless; the resting→working upgrade repaints on the next scan change or the 30s tick.)
    if (JSON.stringify(sessions) === JSON.stringify(this.discovered)) return;
    this.discovered = sessions;
    this.emit();
  }

  /** Current status per visible project key (keyed by action id). Hook state is authoritative;
   * discovery then (a) fills a hook-SILENT project ('none') — active → working, else idle — and
   * (b) upgrades a RESTING hook state (done / needsInput / idle) to 'working' when the repo has
   * been SUSTAINED CPU-active, so a session running a background task (a Claude workflow, which
   * fires `Stop` when it yields the turn yet keeps subagent processes busy) doesn't read as
   * falsely done / waiting-on-you. grey = no session, slate = idle, orange = working. */
  byProject(now = Date.now()): Record<string, ProjectState> {
    const by = statusByProject(this.state, this.projects());
    if (this.discovered.length > 0) {
      const projects = this.projects();
      for (const session of this.discovered) {
        const id = matchProject(session.cwd, projects);
        if (id === undefined) continue;
        const status = by[id]?.status ?? 'none';
        if (status === 'none') {
          by[id] = { status: session.active ? 'working' : 'idle' };
        } else if (
          session.active &&
          (status === 'done' || status === 'needsInput' || status === 'idle') &&
          this.sustainedActive(session.cwd, now)
        ) {
          // Resting per hooks, but the process tree has been busy a while → a background task is
          // running; show working. Keep the prior `since` so the elapsed reflects how long.
          by[id] = { status: 'working', ...(by[id]?.since !== undefined ? { since: by[id]!.since } : {}) };
        }
      }
    }
    return by;
  }

  /** Has this cwd been continuously CPU-active long enough to treat a resting hook state as a
   * running background task (vs a just-stopped session's decaying CPU)? */
  private sustainedActive(cwd: string, now: number): boolean {
    const since = this.activeSince.get(cwd);
    return since !== undefined && now - since >= Board.SUSTAINED_ACTIVE_MS;
  }

  /** The projects currently waiting on the user, most useful first. */
  attention(): ProjectConfig[] {
    const ids = new Set(needsAttention(this.state, this.projects()));
    return this.projects().filter((p) => ids.has(p.id));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const board = new Board();
