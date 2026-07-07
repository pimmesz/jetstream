import { parseClaudeStatusline, writeCache, formatLine } from './index';

/** Statusline hook entry (install into Claude Code settings.json as the status line
 * command). Claude pipes the session JSON on stdin each render; we parse it and, when
 * it carries usage, cache it so the deck can read usage without a live run. Prints a
 * compact line back to the bar and ALWAYS exits 0 — a status line must never break. */
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
  let line = '';
  try {
    const feed = parseClaudeStatusline(JSON.parse(await readStdin()));
    if (feed.available) {
      await writeCache(feed);
      line = formatLine(feed);
    }
  } catch {
    /* best-effort: a bad payload leaves the bar blank, never errors */
  }
  process.stdout.write(`${line}\n`);
}

void main();
