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
 * The plugin-wide board: the hook-event status state + the registry of visible
 * project keys (actionId → {name, path}). Each visible Project key IS a project;
 * its Stream Deck action id doubles as the ProjectConfig id, so settings edits and
 * key removal keep the board consistent without a separate config file.
 */
export class Board {
  private state: StatusState = initialState();
  private registry = new Map<string, ProjectEntry>();
  private sessions = new Map<string, { pid: number; cwd: string }>();
  private listeners = new Set<() => void>();

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
    return [...this.registry.entries()].map(([id, p]) => ({ id, name: p.name, path: p.path }));
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
