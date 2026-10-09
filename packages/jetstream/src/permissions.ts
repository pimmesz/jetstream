import {
  matchProject,
  parsePermissionRequest,
  permissionDecisionJson,
  type PendingPermission,
  type PermissionBehavior,
  type ProjectConfig,
  takeStopFlag,
} from '@pimmesz/jetstream-status';

interface Entry {
  perm: PendingPermission;
  /** The exact Bash command ('' for any other tool): what a Bash Always-Allow is keyed on. */
  command: string;
  /** A Bash request with `dangerouslyDisableSandbox`: its rule is kept apart from the sandboxed one. */
  isUnsandboxed: boolean;
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

/** Tools whose prompt is a question for the user, not a yes/no: Claude ignores an "allow" without
 * the answer in updatedInput, so a deck Approve would do nothing. Leave them to Claude's own dialog. */
const NOT_DECK_ANSWERABLE: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** How many average characters of a prompt's summary the APPROVE/DENY face shows in full. */
// render.ts draws it at 14px, about 7.5px an average character, so 18 fit the 144px key (24 clip).
export const FACE_SUMMARY_MAX = 18;

// CJK, Hangul and full-width forms draw about twice as wide at 14px.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** A character's rough width at 14px, in average characters (about 7.5px): enough to say whether a
 * summary overflows the face, which is all the `*` mark and the compound check need. */
function charWidth(char: string): number {
  if (char.codePointAt(0)! > 0xffff) return 2.4; // emoji draw wider still
  if (WIDE.test(char)) return 2;
  if (char === 'M' || char === 'W') return 1.8;
  if (/[\s.,:;'|!`ijlI]/.test(char)) return 0.5;
  if (/[A-Zmw@%]/.test(char)) return 1.4;
  return 1;
}

/** Whether a summary runs past the face: render.ts cuts it past FACE_SUMMARY_MAX characters, and wide
 * characters overflow the key even before that. */
export function isSummaryCut(summary: string): boolean {
  if (summary.length > FACE_SUMMARY_MAX) return true;
  let width = 0;
  for (const char of summary) width += charWidth(char);
  return width > FACE_SUMMARY_MAX;
}

/** Shell syntax that runs another command beside the first. Claude runs Bash in the user's shell, zsh on macOS. */
const COMPOUND = [
  // zsh runs code from many bracket forms (`$(`, subshells, brace groups, glob qualifiers, `case x)`,
  // `if [[ c ]] cmd`), so any of ( ) { } or [[ counts: the simple safe line. Plus `;`, `|`, a backtick, a newline.
  /[;|`\n(){}]|\[\[/,
  /(?<![<>])&(?!>)/, // `&&`, and a lone `&` that backgrounds one command; `>&` and `&>` are redirections
];

/** A compound command can hide a second command behind the one the user reads, so it is never armed. */
export function isCompound(command: string): boolean {
  return COMPOUND.some((pattern) => pattern.test(command));
}

/** The exact command of a Bash request ('' for any other tool), and whether it asks to leave the sandbox. */
function bashInput(toolName: string, raw: unknown): { command: string; isUnsandboxed: boolean } {
  if (toolName !== 'Bash') return { command: '', isUnsandboxed: false };
  const input = (raw as { tool_input?: { command?: unknown; dangerouslyDisableSandbox?: unknown } | null }).tool_input;
  return {
    command: typeof input?.command === 'string' ? input.command : '',
    isUnsandboxed: input?.dangerouslyDisableSandbox === true,
  };
}

export class Permissions {
  private queue: Entry[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  /** Always-Allow rules the user armed via a long hold on APPROVE. A Bash rule is keyed by
   * `${sessionId}\0Bash\0${sandboxed|unsandboxed}\0${command}` and covers that exact command, run that
   * way, only (a compound one is never armed); any other tool is keyed by `${sessionId}\0${toolName}`. A matching request settles 'allow' with NO
   * keypress. A deliberate, bounded relaxation of "every grant is a keypress": SESSION-scoped (keyed by
   * the unique sessionId, so a rule can never leak to another session or survive it), memory-ONLY
   * (evaporates on plugin restart, never persisted to disk), and COMMAND-scoped for Bash, TOOL-scoped
   * otherwise. Only 'allow' is ever remembered; deny is always one-shot. */
  private allowRules = new Set<string>();
  /** Bound memory over a long-running plugin; oldest rule drops first (insertion order). */
  private static readonly MAX_ALLOW_RULES = 256;

  /** `takeStop` consumes a pending deck stop for a session (stop-flag.ts); injected for tests. */
  constructor(private readonly takeStop: (sessionId: string) => boolean = (id) => takeStopFlag(id)) {}

  private ruleKey(sessionId: string, toolName: string, command: string, isUnsandboxed: boolean): string {
    if (toolName !== 'Bash') return `${sessionId}\u0000${toolName}`;
    // A command approved inside the sandbox never auto-approves the same command outside it.
    return `${sessionId}\u0000Bash\u0000${isUnsandboxed ? 'unsandboxed' : 'sandboxed'}\u0000${command}`;
  }

  /** `abort` fires when the hook stopped waiting (its process died or the session closed), so the
   * prompt leaves the deck instead of showing APPROVE/DENY for nobody until the timeout. */
  request(raw: unknown, timeoutMs = 90_000, abort?: AbortSignal): Promise<string | undefined> {
    const perm = parsePermissionRequest(raw, `perm-${++this.seq}`);
    if (!perm) return Promise.resolve(undefined);
    // A stop pressed after this tool passed the stop gate (one node start-up before its prompt) is
    // still pending: honour it first, before an armed Always-Allow, the deck, or a keyboard-only
    // prompt (a plan approval would otherwise sit waiting after the user asked to stop).
    if (perm.sessionId && this.takeStop(perm.sessionId)) {
      return Promise.resolve(permissionDecisionJson('deny', true));
    }
    if (NOT_DECK_ANSWERABLE.has(perm.toolName)) return Promise.resolve(undefined);
    const { command, isUnsandboxed } = bashInput(perm.toolName, raw);
    // The face cuts a long summary and draws a newline as a space, so a compound command's next
    // command could pass unseen: the deck never answers it and Claude's own dialog shows all of it.
    const isHidden = isSummaryCut(perm.summary) || command.includes('\n');
    if (isCompound(command) && isHidden) return Promise.resolve(undefined);
    // Always-Allow: a matching armed rule auto-approves with no keypress. A non-empty sessionId is
    // required to match, so the '' parse-fallback can never be armed into a wildcard.
    if (perm.sessionId && this.allowRules.has(this.ruleKey(perm.sessionId, perm.toolName, command, isUnsandboxed))) {
      return Promise.resolve(permissionDecisionJson('allow'));
    }
    if (this.queue.length >= MAX_PENDING) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleId(perm.id, undefined), timeoutMs);
      this.queue.push({ perm, command, isUnsandboxed, resolve, timer });
      abort?.addEventListener('abort', () => this.settleId(perm.id, undefined), { once: true });
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

  /** Whether a hold on APPROVE may arm Always-Allow for this request: never for a compound command. */
  canArm(id: string | undefined): boolean {
    const entry = this.queue.find((e) => e.perm.id === id);
    return entry !== undefined && !isCompound(entry.command);
  }

  /** Always-Allow: arm an auto-allow rule for the CURRENT head AND settle it 'allow'.
   * Same head-guard as `settle` (returns false on a stale id, so the caller alerts + repaints
   * instead of arming a rule for a request the user never reviewed). Never remembers a deny.
   * A compound command also returns false and stays pending, for a one-shot answer. */
  allowAlways(expectedId: string | undefined): boolean {
    const entry = this.queue[0];
    if (!entry || entry.perm.id !== expectedId) return false;
    if (isCompound(entry.command)) return false;
    const { sessionId, toolName } = entry.perm;
    // Only arm when we have a real session to scope it to; '' would be an unscoped wildcard.
    if (sessionId) {
      // Bound memory: drop the oldest rule (insertion order) before adding a new one.
      if (this.allowRules.size >= Permissions.MAX_ALLOW_RULES) {
        const oldest = this.allowRules.values().next().value;
        if (oldest !== undefined) this.allowRules.delete(oldest);
      }
      this.allowRules.add(this.ruleKey(sessionId, toolName, entry.command, entry.isUnsandboxed));
    }
    this.settleId(entry.perm.id, permissionDecisionJson('allow'));
    return true;
  }

  /** Deny every request this session is blocked on AND stop its turn (the deck stop key).
   * Returns whether anything was pending. */
  denyAndInterrupt(sessionId: string): boolean {
    if (!sessionId) return false;
    const ids = this.queue.filter((e) => e.perm.sessionId === sessionId).map((e) => e.perm.id);
    for (const id of ids) this.settleId(id, permissionDecisionJson('deny', true));
    return ids.length > 0;
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
    // A prompt the ended session left behind can never be answered: take it off the deck.
    for (const e of this.queue.filter((q) => q.perm.sessionId === sessionId)) this.settleId(e.perm.id, undefined);
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
