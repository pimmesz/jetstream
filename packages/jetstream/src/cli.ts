import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { runClaude } from '@pimmesz/jetstream-claude';
import { runChatSetup, SETUP_SYSTEM } from './chat-setup';
import { pendingEditsPath, pendingStore } from './chat-pending';
import { hookCommands, installHooks } from './hooks-install';
import { recordShellDirs } from './shell-dirs';

export { hookCommands } from './hooks-install';
import { runDoctor, formatReport, commandOnPath } from './doctor';
import { isInputAbort, offerProfile, runInit } from './init';
import {
  buildLayoutProfile,
  detectConnectedDeck,
  detectDeviceModel,
  renderProfileArchive,
  type DeckModel,
} from './profile';
import {
  activeProfileUuids,
  defaultProfilesDir,
  mergeBoard,
  pruneCustomProfiles,
  readBoardLayout,
  renderBoardMap,
} from './board-layout';
import { applyLayout } from './chat-apply';
import { readForeignCatalog } from './plugin-catalog';
import { writeInPlace } from './profile-store';
import { selectOne } from './select';
import { paintCoordByRow, spinner } from './term';
import { pluginAlive, sendSlot } from './slot-client';
import { defaultOpenFile } from './open-file';
import { projectsConfigPath, PROJECTS_TEMPLATE , resolveProjectsConfigPath } from './projects-config';
import { errorMessage } from './errors';

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
  hooks install [--tool-detail]   Wire Jetstream's Claude hooks into Claude's settings.json
                                  (~/.claude, or $CLAUDE_CONFIG_DIR when set)
    [--replace-statusline]        …and take the statusline slot from another tool, so the
                                  usage gauge works (your statusline is kept without this)
  doctor [--json]                 Read-only health check — why isn't my board lighting up?
  setup                           hooks install + create a projects.json template, then next steps
  board                           Print your current Stream Deck board as a coordinate map (a1…hN)
  install                         Hand the packed plugin to the Stream Deck app (npm CLI)
  update                          Update the npm package + reinstall the plugin (npm CLI)
  version                         Show the installed plugin / npm package versions`;

/** Why a chat model turn failed, in the user's terms. */
function chatFailure(result: { result?: string; stderrTail?: string; exitCode: number | null }): string {
  const said = result.result?.trim() || result.stderrTail?.split('\n').pop()?.trim();
  if (said) return said.slice(0, 200);
  return result.exitCode === null ? 'it timed out or could not start' : `claude exited with code ${result.exitCode}`;
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
    console.error(errorMessage(error));
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
    console.error(errorMessage(error));
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
        `Could not create ${path}: ${errorMessage(error)}`,
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
  // The verbs that act on Claude or Codex config record this shell's dirs for the plugin, which
  // starts without the shell profile. doctor stays read-only.
  const shouldRecordDirs =
    command === 'chat' || command === 'init' || command === 'setup' || (command === 'hooks' && rest[0] === 'install');
  if (shouldRecordDirs) {
    const note = recordShellDirs();
    if (note) console.log(note);
  }
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
          '  npm i -g --prefer-online --registry=https://registry.npmjs.org/ --@pimmesz:registry=https://registry.npmjs.org/ @pimmesz/jetstream\n' +
          '  jetstream install',
      );
      return 0;
    }
    case 'install': {
      // Same reason as `update`: the plugin cannot install itself, so the npm `jetstream` bin owns this verb.
      console.log('Install via the npm CLI:\n  npm i -g @pimmesz/jetstream\n  jetstream install');
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
        const board = readBoardLayout();
        return await runChatSetup({
          io: chatIo,
          board,
          readBoard: () => readBoardLayout(),
          // Unsaved live edits outlive this chat, so the next one plans against them too.
          pending: pendingStore(pendingEditsPath()),
          catalog: readForeignCatalog(defaultProfilesDir()),
          paintCoord: paintCoordByRow,
          claudeAvailable: () => commandOnPath('claude'),
          ask: async (prompt) => {
            // A pure text run: no tools, no MCP servers, nothing saved to the session list, and the
            // permission hook skips it (headless runs fire PermissionRequest since Claude Code 2.1.268).
            const result = await runClaude(
              {
                prompt,
                appendSystemPrompt: SETUP_SYSTEM,
                model: 'sonnet',
                tools: '',
                strictMcpConfig: true,
                noSessionPersistence: true,
                cwd: tmpdir(),
                env: { JETSTREAM_SKIP_DECK: '1' },
              },
              () => {},
            );
            if (!result.isError && result.result) return result.result;
            return { error: chatFailure(result) };
          },
          // First board for a fleet with no board yet: the ready-made profile.
          onWritten: async (projects) => {
            chatIo.say('');
            const profilePath = await offerProfile(chatIo, projects, defaultOpenFile());
            chatIo.say(
              profilePath
                ? `Next: confirm the import of ${profilePath} in Stream Deck.`
                : 'Next: drag a Fleet + Attention key onto your deck.',
            );
          },
          onLayout: async (placements, { deck, board: current, onConflict }) => {
            const outcome = await applyLayout(placements, {
              say: chatIo.say,
              confirm: async (question) => {
                const answer = (await chatIo.ask(`\n${question} [y/N] `)).trim().toLowerCase();
                return answer === 'y' || answer === 'yes';
              },
              board: current,
              onConflict,
              boardOnScreen: () => readBoardLayout(),
              pluginAlive,
              sendSlot,
              writeInPlace:
                process.platform === 'darwin'
                  ? (profileDir, edits, pageId, changedSincePlan) =>
                      writeInPlace(profileDir, edits, {
                        ...(pageId ? { pageId } : {}),
                        // Compared after the quit, inside the lock: a key changed since the plan aborts the write.
                        changedSincePlan,
                        jetstreamVersion: pluginVersion(binDir).replace('unknown', '0.0.0.0'),
                        // Clear the copies older chat imports left behind, keeping the board just written.
                        whileQuit: () =>
                          pruneCustomProfiles(defaultProfilesDir(), [
                            ...activeProfileUuids(),
                            basename(profileDir).replace(/\.sdProfile$/i, '').toLowerCase(),
                          ]),
                      })
                  : undefined,
              importProfile: (edits) => {
                const merged = mergeBoard(current, edits);
                const outPath = join(homedir(), 'Downloads', 'Jetstream-Custom.streamDeckProfile');
                mkdirSync(dirname(outPath), { recursive: true });
                rmSync(outPath, { force: true }); // never write THROUGH a symlink left at this path
                writeFileSync(outPath, renderProfileArchive(buildLayoutProfile(deck, merged, detectDeviceModel(deck))));
                defaultOpenFile()?.(outPath);
                return outPath;
              },
            });
            // Run keys are opt-in, so say so when one was just placed, instead of a silent no-op press.
            if (placements.some((p) => (p.settings as { kind?: string } | null)?.kind === 'run')) {
              chatIo.say(
                '(Run keys are off by default. Enable them with "allowRunKeys": true in the "settings" block of\n' +
                  'your projects.json, then restart the Stream Deck app.)',
              );
            }
            return outcome;
          },
        });
      } catch (error) {
        // Only Ctrl-C / EOF is an abort. chat WRITES projects.json before it generates the layout
        // profile, so a later failure (an unwritable ~/Downloads, a TCC denial) used to print
        // "nothing written" one line after "Wrote 3 project(s)" — a false claim, the wrong cause,
        // and the only diagnostic thrown away. `init`'s twin already says "nothing FURTHER".
        if (isInputAbort(error)) {
          console.error('\nAborted — nothing further was written.');
          return 130;
        }
        console.error(`\n${errorMessage(error)}`);
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
