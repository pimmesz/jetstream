import { request } from 'node:http';

/**
 * Claude Code lifecycle-hook entry (install for SessionStart / UserPromptSubmit /
 * Notification / Stop / SessionEnd, etc.). It forwards the hook payload to the
 * Jetstream plugin's local server and exits silently. It also tags the payload with
 * `_pid` (this hook's parent — the `claude` process, since hooks are spawned via
 * argv, not a shell) so the plugin can SIGINT that session on an interrupt press.
 * It prints NOTHING to stdout — some hooks (e.g. UserPromptSubmit) treat stdout as
 * injected context — and always exits 0 so it can never disrupt a Claude session.
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

function post(body: string): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/hook',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

async function main(): Promise<void> {
  const body = await readStdin();
  if (!body.trim()) return;
  // Tag with the parent PID so the plugin can map session → process for interrupt.
  // If the body isn't a JSON object, forward it unchanged.
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    await post(body);
    return;
  }
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    (payload as Record<string, unknown>)._pid = process.ppid;
    await post(JSON.stringify(payload));
  } else {
    await post(body);
  }
}

void main();
