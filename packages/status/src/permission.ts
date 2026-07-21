/**
 * Deck-side permission approval. Claude Code's `PermissionRequest` hook is
 * SYNCHRONOUS — it blocks the session while it runs — so a hook that holds its
 * response until a Stream Deck key is pressed lets you approve/deny from the deck.
 * On exit 0 the hook prints the decision JSON below; printing nothing falls back to
 * Claude's own dialog (so not pressing a key just means you answer at the keyboard).
 */

export type PermissionBehavior = 'allow' | 'deny';

export interface PendingPermission {
  id: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  /** Short human summary for the key face, e.g. `Bash: npm test`. */
  summary: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A one-line description of the tool call for a key face. */
export function summarizeTool(toolName: string, toolInput: unknown): string {
  const input = asRecord(toolInput);
  const detail =
    (typeof input?.command === 'string' && input.command) ||
    (typeof input?.file_path === 'string' && input.file_path) ||
    (typeof input?.path === 'string' && input.path) ||
    (typeof input?.url === 'string' && input.url) ||
    '';
  return detail ? `${toolName}: ${detail}` : toolName;
}

/** Parse the `PermissionRequest` hook payload into a pending request. Returns null
 * when it can't be routed (no cwd → no project key to surface it on). Defensive. */
export function parsePermissionRequest(raw: unknown, id: string): PendingPermission | null {
  const r = asRecord(raw);
  if (!r) return null;
  const cwd = typeof r.cwd === 'string' ? r.cwd : '';
  if (!cwd) return null;
  return {
    id,
    sessionId: typeof r.session_id === 'string' ? r.session_id : '',
    cwd,
    toolName: typeof r.tool_name === 'string' ? r.tool_name : 'tool',
    summary: summarizeTool(typeof r.tool_name === 'string' ? r.tool_name : 'tool', r.tool_input),
  };
}

/** The exact stdout the `PermissionRequest` hook prints to allow/deny (verified
 * against the Claude Code hooks reference). */
export function permissionDecisionJson(behavior: PermissionBehavior): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } },
  });
}

/**
 * Validate a decision that came back over the loopback socket and RE-BUILD it from our own
 * canonical writer — never re-emit the received bytes.
 *
 * Claude treats the PermissionRequest hook's stdout as the AUTHORITATIVE answer, so echoing the
 * response verbatim would make whoever holds the port the decision oracle for every session on the
 * machine (a process that binds it before Stream Deck starts could auto-approve every tool call).
 * Passing only `behavior` through this funnel means an attacker can at most choose allow/deny for a
 * prompt the user is already looking at, never inject arbitrary hook output. Anything unrecognised
 * returns undefined → the hook prints nothing → Claude falls back to its own dialog. Pure.
 */
export function parsePermissionDecision(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const output = asRecord(asRecord(parsed)?.hookSpecificOutput);
  if (output?.hookEventName !== 'PermissionRequest') return undefined;
  const behavior = asRecord(output.decision)?.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') return undefined;
  return permissionDecisionJson(behavior);
}
