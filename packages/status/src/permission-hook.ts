import { request } from 'node:http';

/**
 * Claude Code `PermissionRequest` hook entry (blocking). POSTs the request to the
 * Jetstream plugin's local server and holds until the plugin answers — an
 * Approve/Deny key press resolves it. The plugin's body (the hookSpecificOutput
 * decision JSON) is printed verbatim on exit 0; an empty answer (timeout / no key
 * pressed / plugin down) prints nothing, so Claude falls back to its own dialog and
 * you decide at the keyboard as usual. Never blocks longer than the request timeout.
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

function requestDecision(body: string): Promise<string> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/permission',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 110_000, // under Claude's 600s hook timeout; the plugin also times out sooner
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => resolve(out));
      },
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
    req.end(body);
  });
}

async function main(): Promise<void> {
  const body = await readStdin();
  if (!body.trim()) return;
  const decision = await requestDecision(body);
  if (decision.trim()) process.stdout.write(decision);
}

void main();
