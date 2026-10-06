import { STOP_OUTPUT, takeStopFlag } from './stop-flag';

/**
 * Claude Code `PreToolUse` hook entry: stops the current turn when the deck asked for it. Reads
 * only a local flag file (no network), so it adds a node start-up per tool call and nothing more.
 * Prints nothing and exits 0 unless a stop is pending.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main(): Promise<void> {
  let sessionId: unknown;
  try {
    sessionId = (JSON.parse(await readStdin()) as { session_id?: unknown }).session_id;
  } catch {
    return;
  }
  if (typeof sessionId === 'string' && takeStopFlag(sessionId)) process.stdout.write(STOP_OUTPUT);
}

void main();
