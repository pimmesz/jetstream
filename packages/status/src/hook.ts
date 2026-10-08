import { clearStopFlagOnTurnEnd } from './stop-flag';
import { appendSpool } from './spool';
import { postHook, runStatusHook } from './status-hook';

/**
 * Claude Code lifecycle-hook entry (install for SessionStart / UserPromptSubmit /
 * Notification / Stop / SessionEnd, etc.). It forwards the hook payload to the
 * Jetstream plugin's local server and exits silently. It also tags the payload with
 * `_pid` (this hook's parent, the `claude` process, since hooks are spawned via
 * argv, not a shell) so the plugin can map the session to its process.
 * It prints NOTHING to stdout (some hooks, e.g. UserPromptSubmit, treat stdout as
 * injected context) and always exits 0 so it can never disrupt a Claude session.
 * The logic lives in status-hook.ts, where it is tested.
 */
const PORT = Number(process.env.JETSTREAM_PORT) || 41321;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

void runStatusHook({
  readStdin,
  post: (body) => postHook(body, PORT),
  appendSpool: (body) => appendSpool(body),
  clearStopFlag: (event, sessionId) => clearStopFlagOnTurnEnd(event, sessionId),
  now: Date.now,
  ppid: process.ppid,
});
