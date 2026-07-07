import {
  parsePermissionRequest,
  permissionDecisionJson,
  type PendingPermission,
  type PermissionBehavior,
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

  request(raw: unknown, timeoutMs = 90_000): Promise<string | undefined> {
    const perm = parsePermissionRequest(raw, `perm-${++this.seq}`);
    if (!perm || this.queue.length >= MAX_PENDING) return Promise.resolve(undefined);
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

  /** Answer the head request from a deck key. Returns false when none is pending. */
  settleHead(behavior: PermissionBehavior): boolean {
    const entry = this.queue[0];
    if (!entry) return false;
    this.settleId(entry.perm.id, permissionDecisionJson(behavior));
    return true;
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
