import { fetchChallenge, postPermission, runPermissionHook } from './permission-client';
import { readToken } from './listener-token';

/**
 * Claude Code `PermissionRequest` hook entry (blocking). Asks the Jetstream plugin's local server
 * for a challenge, POSTs the request and holds until the plugin answers (an
 * Approve/Deny key press resolves it). The exchange is signed both ways and the answer is
 * re-built from our own canonical writer (see permission-client.ts). An empty, unsigned or
 * unrecognised answer (timeout / no key pressed / plugin down / a port squatter) prints
 * nothing, so Claude falls back to its own dialog and you decide at the keyboard as usual.
 * Never blocks longer than the request timeout.
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

void runPermissionHook({
  env: process.env,
  readStdin,
  readToken: () => readToken(),
  getChallenge: () => fetchChallenge(PORT, 2_000),
  // Under Claude's 600s hook timeout; the plugin also times out sooner.
  post: (body, headers) => postPermission(PORT, body, headers, 110_000),
  write: (out) => process.stdout.write(out),
});
