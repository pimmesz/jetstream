import {
  initialState,
  reduce,
  statusByProject,
  needsAttention,
  matchProject,
  type HookEvent,
  type ProjectConfig,
  type ProjectState,
  type StatusState,
} from '@pimmesz/jetstream-status';

export interface ProjectEntry {
  name: string;
  path: string;
}

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
  private listeners = new Set<() => void>();

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
    this.emit();
  }

  /** Remember a session's process (the hook's parent PID) so interrupt can SIGINT it. */
  notePid(sessionId: string, pid: number, cwd: string): void {
    if (sessionId && Number.isInteger(pid) && pid > 1) this.sessions.set(sessionId, { pid, cwd });
  }

  /** PIDs of the sessions running under a given project key (for interrupt). */
  pidsForProject(actionId: string): number[] {
    const projects = this.projects();
    return [...this.sessions.values()]
      .filter((s) => matchProject(s.cwd, projects) === actionId)
      .map((s) => s.pid);
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
    const merged = new Map<string, ProjectEntry>(this.seeded);
    for (const [id, entry] of this.registry) merged.set(id, entry); // placed keys win by id
    return [...merged.entries()].map(([id, p]) => ({ id, name: p.name, path: p.path }));
  }

  /** Current status per visible project key (keyed by action id). */
  byProject(): Record<string, ProjectState> {
    return statusByProject(this.state, this.projects());
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
