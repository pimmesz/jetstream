import { request } from 'node:http';
import { MAC_HEADER, runPermissionHook } from './permission-client';
import { readToken } from './listener-token';

/**
 * Claude Code `PermissionRequest` hook entry (blocking). POSTs the request to the
 * Jetstream plugin's local server and holds until the plugin answers (an
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

function post(body: string, headers: Record<string, string>): Promise<{ body: string; mac: unknown }> {
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
          ...headers,
        },
        timeout: 110_000, // under Claude's 600s hook timeout; the plugin also times out sooner
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => resolve({ body: out, mac: res.headers[MAC_HEADER] }));
      },
    );
    req.on('error', () => resolve({ body: '', mac: undefined }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ body: '', mac: undefined });
    });
    req.end(body);
  });
}

void runPermissionHook({
  env: process.env,
  readStdin,
  readToken: () => readToken(),
  post,
  write: (out) => process.stdout.write(out),
});
