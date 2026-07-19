import { execFile } from 'node:child_process';
import { augmentedPath } from './exec-path';

/**
 * Discover running Claude Code CLI sessions, the directory each is in, and whether each is
 * actively burning CPU — so the board can show a project as working (generating / running work)
 * or merely idle (a session open at a prompt) even when its hook events predate this plugin
 * instance (a restart, or a session mid-long-generation and thus not firing a fresh event).
 * Hooks remain authoritative for precise state; this only fills projects the hooks are SILENT
 * on. macOS/Linux via `ps` + `lsof` (both on the Stream Deck GUI's minimal PATH); a no-op on
 * Windows, where cwd isn't cheaply available.
 */

/** A generating/working session burns real CPU (observed 28–31%); an idle session sitting at a
 * prompt is ~0 (observed 0.0–0.1%). This threshold cleanly separates them with margin. `%cpu`
 * is a decaying average, so a just-stopped session may read active briefly — the Stop hook
 * corrects it to `done`, and discovery only fills hook-silent projects anyway. */
const WORKING_CPU_PCT = 5;

export interface DiscoveredSession {
  pid: number;
  cwd: string;
  /** Actively using CPU (generating / running work) vs idle at a prompt. */
  active: boolean;
}

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 4000, maxBuffer: 4_000_000, env: { ...process.env, PATH: augmentedPath() } },
      // Use whatever stdout arrived even on a non-zero exit: `lsof` exits 1 when one of the
      // scanned pids has already died, yet still prints valid cwds for the rest — discarding
      // that would drop every live session whenever one is transient.
      (_err, stdout) => resolve(String(stdout ?? '')),
    );
  });

/** Is this `ps` command line a Claude Code CLI process (vs. some command that merely mentions
 * "claude" as an argument, e.g. `rg claude` / `vim claude.md`)? True when the executable itself
 * is `claude`, or a JS runtime running a claude(-code) script path. */
export function isClaudeCommand(args: string): boolean {
  const tokens = args.trim().split(/\s+/);
  const exe = tokens[0] ?? '';
  const base = (exe.split('/').pop() ?? '').toLowerCase();
  if (base === 'claude') return true; // the `claude` bin/shim (the common install)
  if (/^(node|bun|deno|npx)$/.test(base)) {
    // node/bun running the CLI script: a path token that names claude / claude-code.
    return tokens.slice(1).some((t) => t.includes('/') && /(^|\/)claude(-code)?(\/|\.|$)/i.test(t));
  }
  return false;
}

/** Claude Code CLI processes (pid + %cpu) from `ps -axo pid=,%cpu=,args=` output. Matches the
 * `claude` CLI while excluding the desktop app, this plugin, the bundled hook scripts, and
 * helpers that merely mention "claude" in their args. */
export function parseClaudeProcs(psOutput: string): Array<{ pid: number; cpu: number }> {
  const procs: Array<{ pid: number; cpu: number }> = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const cpu = Number(match[2]);
    const args = match[3] ?? '';
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(cpu)) continue;
    if (!isClaudeCommand(args)) continue; // the `claude` CLI executable, not `claude` as an arg
    if (/Stream ?Deck|jetstream|\.sdPlugin|-hook\.js|Claude\.app|MacOS\/Claude/i.test(args)) {
      continue; // the desktop app / this plugin / hook scripts — not a CLI session
    }
    procs.push({ pid, cpu });
  }
  return procs;
}

/** Map `lsof -Fn` output (per-pid cwd) to pid → cwd. */
export function parseLsofCwd(lsofOutput: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && line.length > 1) out.set(pid, line.slice(1));
  }
  return out;
}

/** Running Claude sessions with their working directory + active flag (empty on Windows or on
 * any error). */
export async function discoverClaudeSessions(exec: Exec = defaultExec): Promise<DiscoveredSession[]> {
  if (process.platform === 'win32') return [];
  const procs = parseClaudeProcs(await exec('ps', ['-axo', 'pid=,%cpu=,args=']));
  if (procs.length === 0) return [];
  const cwds = parseLsofCwd(
    await exec('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', procs.map((p) => p.pid).join(',')]),
  );
  return procs
    .filter((p) => cwds.has(p.pid))
    .map((p) => ({ pid: p.pid, cwd: cwds.get(p.pid)!, active: p.cpu >= WORKING_CPU_PCT }));
}
