import { request } from 'node:http';
import { parsePermissionDecision } from './permission';
import { tokenHeader } from './listener-token';

/**
 * Claude Code `PermissionRequest` hook entry (blocking). POSTs the request to the
 * Jetstream plugin's local server and holds until the plugin answers — an
 * Approve/Deny key press resolves it. The plugin's answer is VALIDATED and re-built from
 * our own canonical writer before it reaches stdout (never echoed verbatim: Claude treats
 * this stdout as the authoritative decision, so a process holding the port must not be able
 * to inject arbitrary hook output). An empty or unrecognised answer (timeout / no key
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
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...tokenHeader(),
        },
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
  // NEVER write the socket's bytes through: Claude treats this stdout as the authoritative
  // decision, so we validate the shape and re-emit from our own canonical writer. An
  // unrecognised answer prints nothing and falls back to Claude's dialog.
  const safe = parsePermissionDecision(decision);
  if (safe) process.stdout.write(safe);
}

void main();
