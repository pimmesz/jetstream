import { execFile } from 'node:child_process';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import { augmentedPath } from './afterburner-cli';

/** Aggregate CI state for a PR — or a roll-up across several. */
export type CiState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// GitHub's `statusCheckRollup` mixes two element shapes: Checks-API runs carry
// `status` + `conclusion`; legacy commit statuses carry `state`.
const FAIL_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

type ElementState = 'failing' | 'pending' | 'passing' | 'unknown';

function classifyElement(el: unknown): ElementState {
  const r = asRecord(el);
  if (!r) return 'unknown';
  if (typeof r.status === 'string') {
    // Checks-API run: not COMPLETED means it's still going (or an unrecognized status).
    if (r.status !== 'COMPLETED') return PENDING_STATUSES.has(r.status) ? 'pending' : 'unknown';
    if (typeof r.conclusion !== 'string') return 'unknown';
    if (FAIL_CONCLUSIONS.has(r.conclusion)) return 'failing';
    if (PASS_CONCLUSIONS.has(r.conclusion)) return 'passing';
    return 'unknown';
  }
  if (typeof r.state === 'string') {
    // Legacy commit status.
    if (r.state === 'FAILURE' || r.state === 'ERROR') return 'failing';
    if (r.state === 'PENDING' || r.state === 'EXPECTED') return 'pending';
    if (r.state === 'SUCCESS') return 'passing';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Pure, fail-closed classification of a PR's `statusCheckRollup` into one CI state.
 * Precedence `failing > unknown > pending > passing`: a red check always wins, and any
 * unreadable element downgrades to `unknown` rather than a false `passing`. An empty array
 * (no CI configured) → `none`; a non-array → `unknown`.
 */
export function classifyChecks(rollup: unknown): CiState {
  if (!Array.isArray(rollup)) return 'unknown';
  if (rollup.length === 0) return 'none';
  let sawUnknown = false;
  let sawPending = false;
  for (const el of rollup) {
    const state = classifyElement(el);
    if (state === 'failing') return 'failing'; // red wins outright
    if (state === 'unknown') sawUnknown = true;
    else if (state === 'pending') sawPending = true;
  }
  if (sawUnknown) return 'unknown';
  if (sawPending) return 'pending';
  return 'passing';
}

const CI_RANK: Record<CiState, number> = {
  failing: 4,
  pending: 3,
  unknown: 2,
  passing: 1,
  none: 0,
};

/** Roll several PRs'/repos' CI states into one, worst-wins:
 * `failing > pending > unknown > passing > none`. Empty input → `none`. Pure. */
export function worstCi(states: CiState[]): CiState {
  let worst: CiState = 'none';
  for (const state of states) {
    if (CI_RANK[state] > CI_RANK[worst]) worst = state;
  }
  return worst;
}

/** Pure state → key face (colour, glyph, label, sub-line). */
export function ciFace(state: CiState): { color: string; glyph: string; label: string; sub: string } {
  switch (state) {
    case 'failing':
      return { color: '#e5484d', glyph: '✗', label: 'CI', sub: 'failing' };
    case 'pending':
      return { color: '#0091ff', glyph: '⋯', label: 'CI', sub: 'running' };
    case 'passing':
      return { color: '#30a46c', glyph: '✓', label: 'CI', sub: 'green' };
    case 'unknown':
      return { color: '#26262b', glyph: '?', label: 'CI', sub: 'no gh' };
    case 'none':
      return { color: '#26262b', glyph: '', label: 'CI', sub: 'no PRs' };
  }
}

/** Injected in tests; runs `gh` and returns its stdout. Same seam shape as diffstat. */
export type CiExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string }>;

const defaultExec: CiExec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    // Augment PATH so `gh` resolves under the Stream Deck GUI's stripped launchd PATH (which
    // lacks /opt/homebrew/bin) — the same fix doctor's health check already applies. Without
    // this the key falsely shows "no gh" even when gh is installed.
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: 5_000, maxBuffer: 4_000_000, env: { ...process.env, PATH: augmentedPath() } },
      (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout) });
      },
    );
  });

/**
 * Impure: the worst CI state across a repo's OPEN pull requests whose head branch starts
 * with `branchPrefix` (default `afterburner/`). Uses `gh` with array argv (never a shell)
 * and carries no untrusted text into the command; returns `unknown` on ANY failure (gh
 * missing / not authed / network / bad JSON) so a CI key can never throw into render.
 * `exec` is injectable for tests.
 */
export async function readRepoCi(
  cwd: string,
  branchPrefix = 'afterburner/',
  exec: CiExec = defaultExec,
): Promise<CiState> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'headRefName,statusCheckRollup', '--limit', '200'],
      { cwd },
    ));
  } catch {
    return 'unknown';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(parsed)) return 'unknown';
  const states: CiState[] = [];
  for (const pr of parsed) {
    const r = asRecord(pr);
    const head = r?.headRefName;
    if (typeof head !== 'string' || !head.startsWith(branchPrefix)) continue;
    states.push(classifyChecks(r?.statusCheckRollup));
  }
  if (states.length === 0) return 'none';
  return worstCi(states);
}

/** Distinct non-empty project paths — dedups the seeded + placed board entries. Pure. */
export function uniquePaths(projects: ProjectConfig[]): string[] {
  const paths = new Set<string>();
  for (const p of projects) if (p.path) paths.add(p.path);
  return [...paths];
}

/** Max concurrent `gh` invocations. A fleet can hold many repos; firing one `gh` per repo at
 * once (a naive `Promise.all`) trips GitHub's rate limit and spikes CPU. A small pool keeps each
 * poll bounded — worst case ⌈repos ÷ this⌉ batches of ~5s each, still well under the 60s cadence. */
const CI_POLL_CONCURRENCY = 5;

/** Run `worker` over `items` with at most `limit` in flight at once. Order-preserving. `worker`
 * here (readRepoCi) already fail-closes to 'unknown', so this never rejects. Pure over its args. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/** Worst CI state across a fleet of repo paths, polling at most `CI_POLL_CONCURRENCY` repos at
 * once (never a `gh` per repo all at once). `read` is injectable for tests; each repo's
 * `readRepoCi` already degrades to `unknown` on failure, so this never rejects. */
export async function pollFleetCi(
  paths: string[],
  branchPrefix: string,
  read: (cwd: string, prefix: string) => Promise<CiState> = readRepoCi,
): Promise<CiState> {
  if (paths.length === 0) return 'none';
  return worstCi(await mapPool(paths, CI_POLL_CONCURRENCY, (p) => read(p, branchPrefix)));
}

/** Whether CI just transitioned INTO failing — for a one-time flash, not a per-poll pulse
 * (a persistent red must not re-alert every poll). Pure. */
export function isNewFailure(prev: CiState, next: CiState): boolean {
  return next === 'failing' && prev !== 'failing';
}
