import { runStopGate, takeStopFlag } from './stop-flag';

/**
 * Claude Code `PreToolUse` hook entry: stops the current turn when the deck asked for it. Reads
 * only a local flag file (no network), so it adds a node start-up per tool call and nothing more.
 * Prints nothing and exits 0 unless a stop is pending. The logic is runStopGate in stop-flag.ts,
 * where it is tested.
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

void runStopGate({
  readStdin,
  take: (sessionId) => takeStopFlag(sessionId),
  write: (output) => process.stdout.write(output),
});
