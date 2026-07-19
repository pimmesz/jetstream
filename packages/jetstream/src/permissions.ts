import {
  matchProject,
  parsePermissionRequest,
  permissionDecisionJson,
  type PendingPermission,
  type PermissionBehavior,
  type ProjectConfig,
} from '@pimmesz/jetstream-status';

interface Entry {
  perm: PendingPermission;
  resolve: (body: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The queue of Claude permission requests waiting on a deck press. The local server
 * calls `request()` when a `PermissionRequest` hook POSTs and keeps its HTTP response
 * open until the returned promise resolves — with the decision JSON (Approve/Deny key)
 * or `undefined` (a timeout, which makes the hook print nothing so Claude shows its own
 * dialog). Requests it can't route to a project (`undefined` from the parser) defer
 * immediately.
 */
/** Cap on simultaneously-held requests — a local process can't pin unbounded memory
 * or sockets; excess requests defer to Claude's own dialog immediately. */
const MAX_PENDING = 32;

export class Permissions {
  private queue: Entry[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  /** Always-Allow rules the user armed via a long-press on APPROVE, keyed by `${sessionId}\0${toolName}`.
   * A matching request settles 'allow' with NO keypress. A deliberate, bounded relaxation of
   * "every grant is a keypress": SESSION-scoped (keyed by the unique sessionId, so a rule can never
   * leak to another session or survive it), memory-ONLY (evaporates on plugin restart — never
   * persisted to disk), and TOOL-scoped. Only 'allow' is ever remembered; deny is always one-shot. */
  private allowRules = new Set<string>();
  /** Bound memory over a long-running plugin; oldest rule drops first (insertion order). */
  private static readonly MAX_ALLOW_RULES = 256;

  private ruleKey(sessionId: string, toolName: string): string {
    return `${sessionId}\u0000${toolName}`;
  }

  request(raw: unknown, timeoutMs = 90_000): Promise<string | undefined> {
    const perm = parsePermissionRequest(raw, `perm-${++this.seq}`);
    if (!perm) return Promise.resolve(undefined);
    // Always-Allow: an armed session+tool auto-approves with no keypress. A non-empty sessionId is
    // required to match, so the '' parse-fallback can never be armed into a wildcard.
    if (perm.sessionId && this.allowRules.has(this.ruleKey(perm.sessionId, perm.toolName))) {
      return Promise.resolve(permissionDecisionJson('allow'));
    }
    if (this.queue.length >= MAX_PENDING) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleId(perm.id, undefined), timeoutMs);
      this.queue.push({ perm, resolve, timer });
      this.emit();
    });
  }

  /** The request a permission key should act on (oldest first). */
  head(): PendingPermission | undefined {
    return this.queue[0]?.perm;
  }

  count(): number {
    return this.queue.length;
  }

  /** Project ids that currently have a HELD permission request — the deck CAN answer
   * these (an approve/deny key resolves the block), unlike an open elicitation (a plain
   * question) which the deck cannot answer and needs the keyboard. Each pending request's
   * cwd is matched to a project; unroutable ones (no matching project) are dropped. */
  projectsWithPending(projects: ProjectConfig[]): Set<string> {
    const ids = new Set<string>();
    for (const { perm } of this.queue) {
      const id = matchProject(perm.cwd, projects);
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  /** Answer the request the deck key ACTUALLY SHOWED, identified by the id it painted —
   * NOT whatever is head at press time. Returns false when that request is no longer the
   * head (it was answered or timed out between paint and press, e.g. a double-tap or a 90s
   * timeout promoting a new head): the caller then alerts + repaints so the user re-decides
   * on the current request instead of blindly approving one they never reviewed. */
  settle(expectedId: string | undefined, behavior: PermissionBehavior): boolean {
    const entry = this.queue[0];
    if (!entry || entry.perm.id !== expectedId) return false;
    this.settleId(entry.perm.id, permissionDecisionJson(behavior));
    return true;
  }

  /** Always-Allow: arm an auto-allow rule for the CURRENT head's session+tool AND settle it 'allow'.
   * Same head-guard as `settle` (returns false on a stale id, so the caller alerts + repaints
   * instead of arming a rule for a request the user never reviewed). Never remembers a deny. */
  allowAlways(expectedId: string | undefined): boolean {
    const entry = this.queue[0];
    if (!entry || entry.perm.id !== expectedId) return false;
    const { sessionId, toolName } = entry.perm;
    // Only arm when we have a real session to scope it to; '' would be an unscoped wildcard.
    if (sessionId) {
      // Bound memory: drop the oldest rule (insertion order) before adding a new one.
      if (this.allowRules.size >= Permissions.MAX_ALLOW_RULES) {
        const oldest = this.allowRules.values().next().value;
        if (oldest !== undefined) this.allowRules.delete(oldest);
      }
      this.allowRules.add(this.ruleKey(sessionId, toolName));
    }
    this.settleId(entry.perm.id, permissionDecisionJson('allow'));
    return true;
  }

  /** Forget a session's armed rules when it ends, so the set doesn't accumulate dead entries over a
   * long plugin run. Session ids are unique, so a stale rule can never match anyway — this is hygiene,
   * and the bound that makes "session-scoped" literally true. Called from the SessionEnd hook path. */
  forgetSession(sessionId: string): void {
    if (!sessionId) return;
    const prefix = `${sessionId}\u0000`;
    let removed = false;
    for (const key of this.allowRules) {
      if (key.startsWith(prefix)) {
        this.allowRules.delete(key);
        removed = true;
      }
    }
    // Repaint the APPROVE key auto-allow affordance when the count actually dropped.
    if (removed) this.emit();
  }

  /** How many Always-Allow rules are armed — for the APPROVE key's "auto-allow active" affordance. */
  allowRuleCount(): number {
    return this.allowRules.size;
  }

  private settleId(id: string, body: string | undefined): void {
    const index = this.queue.findIndex((e) => e.perm.id === id);
    if (index === -1) return;
    const [entry] = this.queue.splice(index, 1);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve(body);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const permissions = new Permissions();
