import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { runClaude } from '@pimmesz/jetstream-claude';
import { runChatSetup, SETUP_SYSTEM } from './chat-setup';
import { installHooks, type HookCommands } from './hooks-install';
import { runDoctor, formatReport, commandOnPath } from './doctor';
import { offerProfile, runInit } from './init';
import {
  buildLayoutProfile,
  detectConnectedDeck,
  detectDeviceModel,
  renderProfileArchive,
  type DeckModel,
} from './profile';
import { mergeBoard, pruneCustomProfiles, readBoardLayout, renderBoardMap } from './board-layout';
import { coordLabel } from './actions/coord';
import { selectOne } from './select';
import { paintCoordByRow, spinner } from './term';
import { pluginAlive, sendSlot } from './slot-client';
import { defaultOpenFile } from './open-file';
import { projectsConfigPath, PROJECTS_TEMPLATE , resolveProjectsConfigPath } from './projects-config';

/**
 * The Jetstream CLI (`bin/jetstream.js`), which lives inside the installed .sdPlugin and is
 * normally driven via the standalone `jetstream` npm bin (`npm i -g @pimmesz/jetstream`), which
 * forwards every verb here. One entry with subcommands; `bin/hooks-install.js` is a thin
 * back-compat alias onto `hooks install`.
 */

const USAGE = `jetstream — Stream Deck plugin CLI

New here? Run \`chat\` — describe your repos and arrange your board in plain English.

Usage:
  jetstream <command> [options]

Commands:
  chat                            Conversational setup: describe your repos AND arrange keys in
                                  plain English — add app/URL/run shortcuts, recolour, rename, set
                                  emoji/logo icons; applied LIVE to your deck (uses your subscription)
  init                            Guided setup: build projects.json (your whole fleet) +
                                  settings, wire the Claude hooks, print next steps
  hooks install [--tool-detail]   Wire Jetstream's Claude hooks into ~/.claude/settings.json
    [--replace-statusline]        …and take the statusline slot from another tool, so the
                                  usage gauge works (your statusline is kept without this)
  doctor                          Read-only health check — why isn't my board lighting up?
  setup                           hooks install + create a projects.json template, then next steps
  board                           Print your current Stream Deck board as a coordinate map (a1…hN)
  update                          Update the npm package + reinstall the plugin (npm CLI)
  version                         Show the installed plugin / npm package versions`;

/** Build the node-quoted hook commands pointing at the sibling bundled hook scripts, so
 * they install with correct absolute paths wherever the .sdPlugin lives. */
/** POSIX-single-quote a path for embedding in the hook command string. Single quotes neutralize
 * every shell metacharacter ($, backticks, ", \), so an install path containing them can't break
 * out of the command; an embedded single quote uses the standard '\'' dance. */
const shellQuote = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;

export function hookCommands(binDir: string, toolDetail: boolean): HookCommands {
  // Stable node symlink survives a Homebrew upgrade; fall back to the installing node.
  const node = existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
  // Skip cleanly if the script is missing (e.g. mid-rebuild), otherwise exec node so
  // its real exit code and errors still surface.
  const cmd = (file: string): string => {
    const script = shellQuote(join(binDir, file));
    return `[ -f ${script} ] || exit 0; exec ${shellQuote(node)} ${script}`;
  };
  return {
    status: cmd('status-hook.js'),
    permission: cmd('permission-hook.js'),
    usage: cmd('usage-hook.js'),
    toolDetail,
  };
}

async function runHooks(args: string[], binDir: string): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'install') {
    console.error(`Unknown hooks command: ${sub ?? '(none)'}\n\n${USAGE}`);
    return 1;
  }
  let toolDetail = false;
  let replaceStatusline = false;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        'tool-detail': { type: 'boolean' },
        'replace-statusline': { type: 'boolean' },
      },
    });
    toolDetail = values['tool-detail'] === true;
    replaceStatusline = values['replace-statusline'] === true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    const result = await installHooks({
      commands: hookCommands(binDir, toolDetail),
      replaceStatusline,
    });
    if (result.changed) {
      console.log(`Jetstream hooks installed into ${result.settingsPath}`);
      if (result.backupCreated) {
        console.log(`(previous settings backed up to ${result.backupPath})`);
      }
      console.log('Restart any running `claude` sessions to pick them up.');
    } else {
      console.log('Jetstream hooks were already installed — nothing changed.');
    }
    // Never leave the gauge dark without saying why: a foreign statusline is kept on purpose,
    // so name it and give the one flag that takes it (this command stays scriptable — `setup`
    // calls it — so it prompts nowhere).
    if (result.statuslineBlocked) {
      console.log('');
      console.log('Your Claude statusline is set to something else, so the usage gauge is NOT');
      console.log('wired and the Usage key will stay blank. Your statusline was left untouched.');
      console.log('To hand the slot to Jetstream: jetstream hooks install --replace-statusline');
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runSetup(binDir: string): Promise<number> {
  const hooksCode = await runHooks(['install'], binDir);
  if (hooksCode !== 0) return hooksCode;

  const path = resolveProjectsConfigPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PROJECTS_TEMPLATE, { flag: 'wx' }); // wx: never overwrite an existing config
    console.log(`Created a starter projects config at ${path} — edit it with your repos.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      console.log(`Projects config already exists at ${path} — left as-is.`);
    } else {
      // A real write failure (EACCES/EROFS/…): don't claim success or print next steps.
      console.error(
        `Could not create ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  console.log(
    [
      '',
      'Next, in the Stream Deck app:',
      '  • Drag a Fleet key and an Attention key onto your deck.',
      '  • Optionally drag a Project key per repo and set its name + path in the Property Inspector.',
      '  • Placed keys are optional — the fleet & doorbell already cover every repo in projects.json.',
    ].join('\n'),
  );
  return 0;
}

/**
 * Route argv (already sliced past `node <script>`) to a subcommand and return the process
 * exit code. Never calls `process.exit`, so the dispatch is unit-testable. `binDir` is the
 * CLI's own directory at runtime, where the bundled hook scripts sit alongside it.
 */
/** The installed plugin's own version, from the manifest that ships one level above bin/. */
function pluginVersion(binDir: string): string {
  try {
    const raw = readFileSync(join(binDir, '..', 'manifest.json'), 'utf8');
    const version = (JSON.parse(raw) as { Version?: unknown }).Version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function run(argv: string[], binDir: string): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'version':
    case '--version':
    case '-v': {
      // The PLUGIN's version (its sdPlugin manifest). The npm wrapper answers `--version`
      // itself with the package version and adds this line when the plugin is installed.
      console.log(`Jetstream plugin ${pluginVersion(binDir)}`);
      return 0;
    }
    case 'update': {
      // The plugin CLI lives inside the plugin, so it can't replace its own package — the
      // npm-installed `jetstream` bin owns this verb (it intercepts `update` before forwarding
      // here). Reaching this case means an old wrapper or a direct bin invocation: say how.
      // Pin BOTH registry forms — a `@pimmesz:registry` line in .npmrc overrides a plain
      // `--registry`, and a bare `npm i -g` against a stale mirror is the exact failure
      // `jetstream update` exists to prevent. Printing it here would hand it right back.
      console.log(
        'Update via the npm CLI:\n' +
          '  npm i -g --registry=https://registry.npmjs.org/ --@pimmesz:registry=https://registry.npmjs.org/ @pimmesz/jetstream\n' +
          '  jetstream install',
      );
      return 0;
    }
    case 'init': {
      // The one interactive command: a real readline over stdin/stdout. runInit itself
      // takes injected io, so the wizard is unit-tested without a tty; only this thin
      // wiring is exercised interactively. Both abort gestures exit cleanly: Ctrl-C
      // rejects the pending question (ABORT_ERR), and stdin EOF (Ctrl-D / piped input
      // running out) would leave it pending forever — the close-sentinel race settles it.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new Promise<never>((_, reject) =>
        rl.once('close', () => reject(new Error('input closed'))),
      );
      closed.catch(() => {}); // fired by the finally's rl.close() after a normal run
      try {
        return await runInit({
          io: {
            ask: (q) => Promise.race([rl.question(q), closed]),
            say: (line) => console.log(line),
          },
          commands: hookCommands(binDir, false),
          detectDeck: detectConnectedDeck,
        });
      } catch {
        console.error('\nAborted — nothing further was written.');
        return 130;
      } finally {
        rl.close();
      }
    }
    case 'chat': {
      // Same interactive readline seam as `init`; runChatSetup takes injected io + agent, so
      // the loop is unit-tested without a tty or a real `claude`. Here the agent is a one-shot
      // `claude -p` per turn (subscription auth via sanitizeEnv), carrying the transcript.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new Promise<never>((_, reject) =>
        rl.once('close', () => reject(new Error('input closed'))),
      );
      closed.catch(() => {});
      const chatIo = {
        ask: (q: string) => Promise.race([rl.question(q), closed]),
        say: (line: string) => console.log(line),
        select: <T>(prompt: string, choices: { label: string; hint?: string; value: T }[]) =>
          selectOne(rl, prompt, choices),
        spinner,
      };
      try {
        return await runChatSetup({
          io: chatIo,
          board: readBoardLayout(),
          paintCoord: paintCoordByRow,
          claudeAvailable: () => commandOnPath('claude'),
          ask: async (prompt) => {
            const result = await runClaude({ prompt, appendSystemPrompt: SETUP_SYSTEM }, () => {});
            return result.isError || !result.result ? null : result.result;
          },
          // After the fleet is written, build the whole deck layout in the same conversation:
          // pick a deck, generate the importable .streamDeckProfile, and open it — so `chat`
          // is a full talk-to-set-up flow, not just projects.json.
          onWritten: async (projects) => {
            chatIo.say('');
            const profilePath = await offerProfile(chatIo, projects, defaultOpenFile());
            chatIo.say(
              profilePath
                ? `Next: double-click ${profilePath} to import it (installs as a new profile — nothing is overwritten).`
                : 'Next: drag a Fleet + Attention key onto your deck.',
            );
          },
          // When the model designed a full key layout ("open telegram at a8"), apply it. Slots go
          // LIVE (retargeted in place on the running plugin — no profile, no import); anything
          // structural (a project/native key, or the plugin being down) falls back to generating an
          // importable .streamDeckProfile.
          onLayout: async (layout) => {
            const slotEdits = layout.placements.filter((p) => p.uuid === 'gg.pim.jetstream.slot');
            const structural = layout.placements.filter((p) => p.uuid !== 'gg.pim.jetstream.slot');
            // Run keys are opt-in — flag it at creation so a new one isn't a silent no-op on press.
            const runNote = layout.placements.some((p) => (p.settings as { kind?: string } | null)?.kind === 'run')
              ? '\n(Run keys only fire once you enable "allow run keys" in Jetstream settings.)'
              : '';
            const alive = structural.length === 0 && slotEdits.length > 0 ? await pluginAlive() : false;
            // The plugin being down is a DIFFERENT problem from a coordinate having no key, and it
            // used to fall through with no explanation at all — indistinguishable from "that key
            // type needs an import", which does get one.
            if (structural.length === 0 && slotEdits.length > 0 && !alive) {
              chatIo.say(
                "\n(the Jetstream plugin isn't answering — is the Stream Deck app running? — so this\n" +
                  'can\'t be applied live; generating an importable profile instead.)',
              );
            }
            if (alive) {
              const results = await Promise.all(
                slotEdits.map(async (p) => {
                  const coord = coordLabel(p.column, p.row);
                  // KEEP the status. Collapsing it to a boolean reported every failure — a 401, a
                  // 500, a connection timeout, an old plugin with no /slot endpoint — as "that
                  // coordinate has no key", sending the user to fix the wrong thing.
                  const status = await sendSlot({ coord, ...(p.settings ?? {}) });
                  return { coord, ok: status === 200, status };
                }),
              );
              const failed = results.filter((r) => !r.ok);
              if (failed.length === 0) {
                chatIo.say(
                  `\n✓ Applied live to your board — no import needed ` +
                    `(${slotEdits.length} key${slotEdits.length > 1 ? 's' : ''}: ${results.map((r) => r.coord).join(', ')}).` +
                    runNote,
                );
                return;
              }
              // Say WHY and what happens next. "Not on your profile" reads like a failure; the
              // real cause is that a live edit can only retarget a key that already exists (the
              // Stream Deck API cannot create one), and the profile below genuinely fixes it —
              // it merges your current board with the new keys, so nothing is lost.
              // Name the actual cause per status; only 404 means "no key there".
              const reason = (status: number): string => {
                if (status === 404) return 'has no key yet (a live edit can only change a key that already exists)';
                if (status === 401) return 'was refused by the plugin (token mismatch) — restart the Stream Deck app';
                if (status === -1) return "didn't get a confirmation from the plugin (it may have applied anyway)";
                return `was rejected by the plugin (HTTP ${status})`;
              };
              for (const f of failed) chatIo.say(`\n(${f.coord} ${reason(f.status)}.)`);
              chatIo.say(
                'Generating an importable profile instead — it keeps your current board and adds ' +
                  'these; double-click it to apply.',
              );
            }
            // Fallback: rebuild + import the whole board (structural change, plugin down, or a live miss).
            const placements = mergeBoard(readBoardLayout(), layout.placements);
            const outPath = join(homedir(), 'Downloads', 'Jetstream-Custom.streamDeckProfile');
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(
              outPath,
              renderProfileArchive(buildLayoutProfile(layout.deck, placements, detectDeviceModel(layout.deck))),
            );
            defaultOpenFile()?.(outPath);
            // Auto-clean: drop any redundant older "Jetstream Custom" copies from the store (keeps the
            // real board), so imports can't pile up. Stream Deck's in-memory list settles on next restart.
            const pruned = pruneCustomProfiles();
            // Say WHY a copy was still needed, so it never looks like a silent fallback: native
            // Elgato action types (launch/approve/nav/text/…) can't be placed live — only a profile
            // import can add them — while slot kinds (apps, repos, folded keys) normally apply live.
            const nativeNames = [...new Set(structural.map((p) => p.name))].join(', ');
            const why =
              structural.length > 0
                ? ` — ${structural.length} native Stream Deck ${structural.length > 1 ? 'keys' : 'key'} (${nativeNames}) can only be added by import`
                : '';
            chatIo.say(
              `\nWrote a ${placements.length}-key layout (${layout.placements.length} changed) to ${outPath}${why}.\n` +
                'Double-click it to import (installs as a new profile — nothing is overwritten).' +
                (pruned.length ? `\n(Cleaned up ${pruned.length} old duplicate profile${pruned.length > 1 ? 's' : ''}.)` : '') +
                runNote,
            );
          },
        });
      } catch (error) {
        // Only Ctrl-C / EOF is an abort. chat WRITES projects.json before it generates the layout
        // profile, so a later failure (an unwritable ~/Downloads, a TCC denial) used to print
        // "nothing written" one line after "Wrote 3 project(s)" — a false claim, the wrong cause,
        // and the only diagnostic thrown away. `init`'s twin already says "nothing FURTHER".
        const aborted =
          (error as { code?: string })?.code === 'ABORT_ERR' ||
          (error instanceof Error && error.message === 'input closed');
        if (aborted) {
          console.error('\nAborted — nothing further was written.');
          return 130;
        }
        console.error(`\n${error instanceof Error ? error.message : String(error)}`);
        return 1;
      } finally {
        rl.close();
      }
    }
    case 'board': {
      const board = readBoardLayout();
      if (!board) {
        console.log(
          'No Jetstream board found — if your deck is on another profile, switch to your Jetstream\n' +
            'board and retry, or run `jetstream chat` to build one.',
        );
        return 0;
      }
      console.log(`${board.profileName} · ${board.deck.label}\n`);
      console.log(renderBoardMap(board, paintCoordByRow));
      return 0;
    }
    case 'hooks':
      return runHooks(rest, binDir);
    case 'doctor': {
      // `--json` for a copy-pasteable support bundle (also what the in-app "Copy diagnostics"
      // sends); the default is the human-readable report.
      const results = await runDoctor();
      console.log(rest.includes('--json') ? JSON.stringify(results, null, 2) : formatReport(results));
      return 0; // doctor is advisory — always exit 0
    }
    case 'setup':
      return runSetup(binDir);
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    case undefined:
      console.error(USAGE);
      return 1;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}
