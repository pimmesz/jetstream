import { spawn, execFileSync } from 'node:child_process';

/** POSIX single-quote shell escaping: safe to embed in a `sh`-parsed string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface Command {
  cmd: string;
  args: string[];
}

/**
 * The "jump to project" command: open a terminal at the project path resuming its
 * Claude session (`claude --continue`). Pure builder so quoting is unit-testable —
 * the project path is user config, but it still never reaches a shell unescaped.
 * Returns null on platforms without a v1 strategy (the key shows an alert instead).
 */
export function buildOpenCommand(path: string, platform: NodeJS.Platform): Command | null {
  if (platform === 'darwin') {
    const inner = `cd ${shellQuote(path)} && claude --continue`;
    return {
      cmd: 'osascript',
      args: [
        '-e',
        'tell application "Terminal" to activate',
        '-e',
        `tell application "Terminal" to do script "${appleScriptQuote(inner)}"`,
      ],
    };
  }
  if (platform === 'win32') {
    // BUILD VERIFY on a real Windows box: start-in-new-window quoting via cmd. Refuse
    // a path we can't safely embed in a cmd string rather than risk a break-out.
    if (/["&|%<>^]/.test(path)) return null;
    return {
      cmd: 'cmd',
      args: ['/c', 'start', 'Claude', 'cmd', '/k', `cd /d "${path}" && claude --continue`],
    };
  }
  return null;
}

/** Is `pid` a live process whose command mentions `claude`? Guards interrupt against
 * PID reuse and against a hook parent that turned out to be a shell wrapper — we only
 * SIGINT something that actually looks like the Claude session. macOS/Linux only. */
export function isClaudeProcess(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return /claude/i.test(out);
  } catch {
    return false; // no such process, or ps unavailable → don't kill
  }
}

/** SIGINT the given PIDs that are verified to still be Claude sessions. Returns how
 * many were signalled (0 = nothing safe to interrupt). */
export function interruptPids(pids: number[], platform: NodeJS.Platform = process.platform): number {
  let sent = 0;
  for (const pid of pids) {
    if (!isClaudeProcess(pid, platform)) continue;
    try {
      process.kill(pid, 'SIGINT');
      sent += 1;
    } catch {
      /* process exited between the check and the signal */
    }
  }
  return sent;
}

/** Fire the jump command, detached so the terminal outlives the plugin process.
 * Returns false when the platform has no strategy or the spawn fails synchronously. */
export function openProject(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const command = buildOpenCommand(path, platform);
  if (!command) return false;
  try {
    const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* nothing to surface post-hoc; the key press already gave feedback */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
