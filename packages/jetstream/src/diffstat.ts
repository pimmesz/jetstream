import { execFile } from 'node:child_process';

/** Added/deleted line totals for a session's change, from `git diff --numstat`. */
export interface DiffStat {
  added: number;
  deleted: number;
}

/**
 * Pure: sum the two leading columns of `git diff --numstat` output. Each line is
 * `<added>\t<deleted>\t<path>`; a binary file reports `-\t-\t<path>`, whose non-numeric
 * columns are skipped. Blank/malformed lines are ignored too, so partial or surprising
 * output can never throw — the worst case is an undercount, never a crash.
 */
export function parseNumstat(output: string): DiffStat {
  let added = 0;
  let deleted = 0;
  for (const line of output.split('\n')) {
    const [a, d] = line.split('\t');
    if (a === undefined || d === undefined) continue;
    // Only plain non-negative integer columns count. This drops binary `-` rows AND any
    // surprising token (a negative, `1e3`, whitespace) rather than coercing it via Number.
    if (!/^\d+$/.test(a) || !/^\d+$/.test(d)) continue;
    added += Number(a);
    deleted += Number(d);
  }
  return { added, deleted };
}

/** Injected in tests; runs `git` and returns its stdout. */
export type DiffStatExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string }>;

const defaultExec: DiffStatExec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    // Bound the read so a huge/hung repo can't stall the plugin; treat any error as "no stat".
    execFile(cmd, args, { cwd: opts.cwd, timeout: 3_000, maxBuffer: 4_000_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

/**
 * Impure: read a session's change magnitude — working tree vs HEAD — in `cwd`. Returns
 * null on ANY failure (not a git repo, no HEAD yet, git missing, timeout), because the
 * diff badge is best-effort and must NEVER throw into the render path. `exec` is
 * injectable for tests. (Working-tree-vs-HEAD is the v1.3 MVP; resolving the true session
 * base ref is a later refinement.)
 */
export async function readDiffStat(
  cwd: string,
  exec: DiffStatExec = defaultExec,
): Promise<DiffStat | null> {
  try {
    const { stdout } = await exec('git', ['diff', '--numstat', 'HEAD'], { cwd });
    return parseNumstat(stdout);
  } catch {
    return null;
  }
}

/** Compact badge for a done key: `+120/-40`. Empty string when nothing changed. */
export function formatDiffStat(stat: DiffStat | null): string {
  if (!stat || (stat.added === 0 && stat.deleted === 0)) return '';
  return `+${stat.added}/-${stat.deleted}`;
}
