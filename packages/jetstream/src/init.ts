import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import { DEFAULTS, LIMITS, type JetstreamConfig } from './config';
import { addToFleet, canonical, expandHome, renderProjectsJson, scanForGitRepos } from './fleet';
import { installHooks, type HookCommands } from './hooks-install';
import { DECK_MODELS, writeProfileFile } from './profile';
import { parseProjectsConfig, projectsConfigPath } from './projects-config';

/**
 * `jetstream init` — the guided onboarding: build the whole fleet config in one sitting
 * (projects.json with every repo + a settings preset) and wire the Claude hooks, so the
 * only thing left is dragging a few generic keys in the Stream Deck app. The plugin's
 * first-launch auto-wire already covers the hooks; init's real value is the fleet file
 * nobody wants to hand-write. I/O rides an injected `ask`/`say` pair so the whole wizard
 * is unit-testable without a tty.
 */

export interface InitIo {
  ask(question: string): Promise<string>;
  say(line: string): void;
}

export interface InitDeps {
  io: InitIo;
  /** Hook commands for this install's bin dir (built by the CLI via `hookCommands`) —
   * passed in rather than imported so init.ts and cli.ts don't import each other. */
  commands: HookCommands;
  /** Where projects.json lives; injectable for tests. */
  configPath?: string;
  /** Injected in tests; defaults to the real installer. */
  install?: typeof installHooks;
  /** Base for resolving relative paths the user types; defaults to process.cwd(). */
  cwd?: string;
  /** Opens the generated .streamDeckProfile in the Stream Deck app. Injectable for
   * tests; defaults to a real spawn on macOS/Windows and UNDEFINED elsewhere — when
   * undefined the "open it now?" question isn't asked at all. */
  openFile?: (path: string) => void;
}

const yes = (answer: string): boolean => /^y(es)?$/i.test(answer.trim());

/** Strip control bytes (incl. ESC) from untrusted on-disk names before they hit the
 * terminal — a directory named with ANSI escapes must not steer the user's console. */
const safe = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, '');

/** Parse a "1,3,5" style pick against a 1-based list of `count` items. Empty or 'all'
 * selects everything; only fully numeric tokens count (so "1-3" is dropped rather than
 * misread as 1); out-of-range numbers are dropped; duplicates collapse. Returns 0-based
 * indices in selection order. */
export function parseSelection(input: string, count: number): number[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'all') return Array.from({ length: count }, (_, i) => i);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of trimmed.split(/[\s,]+/)) {
    if (!/^\d+$/.test(part)) continue;
    const n = Number.parseInt(part, 10);
    if (n < 1 || n > count || seen.has(n - 1)) continue;
    seen.add(n - 1);
    out.push(n - 1);
  }
  return out;
}

/** Ask for a number, defaulting on Enter. Answers outside [min, max] keep the default
 * with a warning — the plugin clamps to that range at runtime anyway (config.LIMITS),
 * so accepting them would write settings the runtime silently overrides. Returns
 * undefined when the default should stand (not written to settings). */
async function askNumber(
  io: InitIo,
  question: string,
  fallback: number,
  range: { min: number; max: number },
): Promise<number | undefined> {
  const raw = (await io.ask(`${question} [${fallback}]: `)).trim();
  if (raw === '') return undefined; // keep the default → not written to settings
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) {
    io.say(`  (couldn't read "${safe(raw)}" as a number — keeping ${fallback})`);
    return undefined;
  }
  if (n < range.min || n > range.max) {
    io.say(`  (${n} is outside the accepted ${range.min}–${range.max} — keeping ${fallback})`);
    return undefined;
  }
  return n === fallback ? undefined : n;
}

async function collectProjects(io: InitIo, cwd: string): Promise<ProjectConfig[]> {
  let projects: ProjectConfig[] = [];
  // addToFleet is the ONE place the add rules live (canonicalize, dedup, id, name
  // fallback) — shared with the in-app editor so the two paths can't diverge.
  const add = (rawPath: string, rawName: string): void => {
    const result = addToFleet(projects, { path: rawPath, name: rawName });
    if (result.reason === 'duplicate') {
      io.say(`  (already added: ${safe(canonical(rawPath))})`);
      return;
    }
    if (result.added) {
      projects = result.projects;
      io.say(`  + ${safe(result.added.name)} → ${safe(result.added.path)}`);
    }
  };

  const scanDir = (await io.ask('Folder to scan for git repos (Enter to skip): ')).trim();
  if (scanDir) {
    const dir = resolve(cwd, expandHome(scanDir));
    const repos = scanForGitRepos(dir);
    if (repos.length === 0) {
      io.say(`No git repos found directly under ${safe(dir)}.`);
    } else {
      repos.forEach((repo, i) => io.say(`  ${i + 1}. ${safe(repo)}`));
      const picked = await io.ask('Add which? (numbers like 1,3 — Enter for all): ');
      const selection = parseSelection(picked, repos.length);
      if (picked.trim() !== '' && selection.length === 0) {
        io.say(`  (couldn't read "${safe(picked.trim())}" — use numbers like 1,3, or Enter for all)`);
      }
      for (const i of selection) {
        const repo = repos[i]!;
        add(repo, basename(repo));
      }
    }
  }

  for (;;) {
    // Strip control bytes from the TYPED path before it's resolved and stored — the scan
    // branch's paths are real dirs, but a manually-typed answer is untrusted input that
    // would otherwise carry escape sequences straight into projects.json.
    const answer = safe((await io.ask('Add a project by path (Enter to finish): ')).trim());
    if (!answer) break;
    const path = resolve(cwd, expandHome(answer));
    if (!existsSync(path)) {
      if (!yes(await io.ask(`  ${safe(path)} doesn't exist — add anyway? [y/N] `))) continue;
    } else if (!existsSync(join(path, '.git'))) {
      io.say(`  (note: ${safe(path)} isn't a git repo root — fine if that's intentional)`);
    }
    const fallback = basename(path) || 'project';
    const name = (await io.ask(`  Name [${safe(fallback)}]: `)).trim() || fallback;
    add(path, name);
  }
  return projects;
}

/** Offer a ready-made key layout as a double-clickable .streamDeckProfile (see profile.ts
 * for the grounded-format rationale). Optional and best-effort: skipping or a write failure
 * never fails init — the drag-keys path always remains. Returns the artifact path when one
 * was written, for the next-steps copy. */
async function offerProfile(
  io: InitIo,
  cwd: string,
  projects: ProjectConfig[],
  openFile: ((path: string) => void) | undefined,
): Promise<string | undefined> {
  io.say('Optional: prebuild a ready-made key layout you can import with a double-click.');
  DECK_MODELS.forEach((deck, i) => io.say(`  ${i + 1}. ${deck.label}`));
  const answer = (await io.ask('Which Stream Deck do you have? (number, Enter to skip): ')).trim();
  if (answer === '') return undefined;
  const deck = DECK_MODELS[Number.parseInt(answer, 10) - 1];
  if (!deck) {
    io.say(`  (no deck matches "${safe(answer)}" — skipping the layout; drag keys by hand instead)`);
    return undefined;
  }
  const outPath = join(cwd, 'Jetstream.streamDeckProfile');
  try {
    // Never follow a pre-existing file or symlink blindly: confirm, then remove the
    // entry itself before writing fresh (writeFileSync would write THROUGH a symlink).
    let existing;
    try {
      existing = lstatSync(outPath);
    } catch {
      existing = undefined;
    }
    if (existing) {
      const what = existing.isSymbolicLink()
        ? `${safe(outPath)} is a symlink`
        : `${safe(outPath)} already exists`;
      if (!yes(await io.ask(`  ${what} — replace it? [y/N] `))) {
        io.say('  (kept the existing file — no layout written)');
        return undefined;
      }
      unlinkSync(outPath);
    }
    const built = writeProfileFile(outPath, deck, projects);
    const projectNote =
      deck.key === 'mini'
        ? 'no per-project keys fit a Mini — the Fleet key covers every repo'
        : `${built.placedProjects} project key${built.placedProjects === 1 ? '' : 's'}${
            built.skippedProjects > 0
              ? `; ${built.skippedProjects} didn't fit and stay covered by the Fleet key`
              : ''
          }`;
    io.say(`Wrote ${safe(outPath)} (${projectNote}).`);
    if (openFile && yes(await io.ask('Open it now so Stream Deck can install it? [y/N] '))) {
      openFile(outPath);
      io.say('  (pick your deck in the dialog that opens — it installs as a NEW profile,');
      io.say('   your existing layout is untouched)');
    }
    return outPath;
  } catch (error) {
    io.say(
      `Could not write the layout (${error instanceof Error ? error.message : String(error)}) — drag keys by hand instead.`,
    );
    return undefined;
  }
}

async function collectSettings(io: InitIo): Promise<Partial<JetstreamConfig>> {
  const settings: Partial<JetstreamConfig> = {};
  if (yes(await io.ask('High-contrast (colour-blind friendly) theme? [y/N] '))) {
    settings.theme = 'highContrast';
  }
  const escalate = await askNumber(
    io,
    'Attention: flash after this many unanswered seconds',
    DEFAULTS.escalateAfterSec,
    LIMITS.escalateAfterSec,
  );
  if (escalate !== undefined) settings.escalateAfterSec = escalate;
  const longPress = await askNumber(
    io,
    'Long-press to interrupt (ms)',
    DEFAULTS.longPressMs,
    LIMITS.longPressMs,
  );
  if (longPress !== undefined) settings.longPressMs = longPress;
  const refresh = await askNumber(
    io,
    'Usage gauge refresh (seconds)',
    DEFAULTS.usageRefreshSec,
    LIMITS.usageRefreshSec,
  );
  if (refresh !== undefined) settings.usageRefreshSec = refresh;
  return settings;
}

/** The platform's real "open this file" launcher, or undefined where none exists —
 * argv arrays only, never a shell, so the path can't be re-parsed as a command. */
function defaultOpenFile(): ((path: string) => void) | undefined {
  if (process.platform === 'darwin') return (path) => execFile('open', [path], () => {});
  if (process.platform === 'win32') return (path) => execFile('explorer', [path], () => {});
  return undefined;
}

export async function runInit(deps: InitDeps): Promise<number> {
  const io = deps.io;
  const install = deps.install ?? installHooks;
  const configPath = deps.configPath ?? projectsConfigPath();
  const cwd = deps.cwd ?? process.cwd();

  io.say('Jetstream init — define your fleet once; the deck covers all of it.');
  io.say('');

  const projects = await collectProjects(io, cwd);
  if (projects.length === 0) {
    io.say('No projects added — Fleet/Attention stay empty until projects.json lists repos');
    io.say('or you place per-project keys in the Stream Deck app.');
  }
  io.say('');
  const settings = await collectSettings(io);
  io.say('');

  // Write projects.json — never clobber an existing fleet without an explicit yes.
  const rendered = renderProjectsJson(projects, settings);
  if (parseProjectsConfig(rendered).length !== projects.length) {
    // By construction this can't happen; if a field rename ever breaks the round-trip,
    // fail loudly instead of writing a file the plugin would silently ignore.
    io.say('Internal error: the generated projects.json does not parse back — nothing written.');
    return 1;
  }
  let write = true;
  if (existsSync(configPath)) {
    write = yes(await io.ask(`${configPath} already exists — overwrite it? [y/N] `));
    if (!write) {
      io.say('Left the existing projects.json as-is.');
      if (Object.keys(settings).length > 0) {
        io.say('  (note: your theme/timing answers were NOT saved — they only live in');
        io.say('   projects.json; add a "settings" block there by hand, or re-run init)');
      }
    }
  }
  if (write) {
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, rendered);
      io.say(
        `Wrote ${configPath} (${projects.length} project${projects.length === 1 ? '' : 's'}).`,
      );
    } catch (error) {
      io.say(
        `Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  // Wire the Claude hooks (idempotent; the plugin's first-launch auto-wire does the same).
  try {
    const result = await install({ commands: deps.commands });
    if (result.changed) {
      io.say(`Jetstream hooks installed into ${result.settingsPath}.`);
      if (result.backupCreated) io.say(`(previous settings backed up to ${result.backupPath})`);
    } else {
      io.say('Jetstream hooks were already installed — nothing changed.');
    }
  } catch (error) {
    io.say(
      `Could not install the Claude hooks: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  io.say('');
  const profilePath = await offerProfile(io, cwd, projects, deps.openFile ?? defaultOpenFile());

  io.say('');
  io.say('Done. Next, in the Stream Deck app:');
  if (profilePath) {
    io.say(`  • Import the layout: double-click ${safe(profilePath)} and pick your deck`);
    io.say('    in the dialog (it installs as a new profile — nothing is overwritten).');
  } else {
    io.say('  • Drag a Fleet key and an Attention key onto your deck — they cover every');
    io.say('    repo in projects.json.');
    io.say('  • Optionally add a Usage gauge, a CI/PR key, and per-project keys.');
  }
  io.say('  • Restart any running `claude` sessions so the hooks report in.');
  io.say('  • `jetstream doctor` checks the wiring if the board stays dark.');
  return 0;
}
