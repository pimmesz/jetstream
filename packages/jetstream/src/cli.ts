import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runClaude } from '@pimmesz/jetstream-claude';
import { runChatSetup, SETUP_SYSTEM } from './chat-setup';
import { installHooks, type HookCommands } from './hooks-install';
import { runDoctor, formatReport } from './doctor';
import { offerProfile, runInit } from './init';
import { defaultOpenFile } from './open-file';
import { projectsConfigPath, PROJECTS_TEMPLATE } from './projects-config';

/**
 * The Jetstream CLI (`bin/jetstream.js`), run from inside the installed .sdPlugin — it
 * ships via the Elgato Marketplace, so there is no `jetstream` command on PATH. One entry
 * with subcommands; `bin/hooks-install.js` is a thin back-compat alias onto `hooks install`.
 */

const USAGE = `jetstream — Stream Deck plugin CLI (run from inside the installed .sdPlugin)

Usage:
  node "<plugin>/bin/jetstream.js" <command> [options]

Commands:
  init                            Guided setup: build projects.json (your whole fleet) +
                                  settings, wire the Claude hooks, print next steps
  chat                            Conversational setup: describe your repos in plain English
                                  and Claude builds your fleet (uses your subscription)
  hooks install [--tool-detail]   Wire Jetstream's Claude hooks into ~/.claude/settings.json
  doctor                          Read-only health check — why isn't my board lighting up?
  setup                           hooks install + create a projects.json template, then next steps`;

/** Build the node-quoted hook commands pointing at the sibling bundled hook scripts, so
 * they install with correct absolute paths wherever the .sdPlugin lives. */
export function hookCommands(binDir: string, toolDetail: boolean): HookCommands {
  const cmd = (file: string): string => `"${process.execPath}" "${join(binDir, file)}"`;
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
  try {
    const { values } = parseArgs({ args: rest, options: { 'tool-detail': { type: 'boolean' } } });
    toolDetail = values['tool-detail'] === true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    const result = await installHooks({ commands: hookCommands(binDir, toolDetail) });
    if (result.changed) {
      console.log(`Jetstream hooks installed into ${result.settingsPath}`);
      if (result.backupCreated) {
        console.log(`(previous settings backed up to ${result.backupPath})`);
      }
      console.log('Restart any running `claude` sessions to pick them up.');
    } else {
      console.log('Jetstream hooks were already installed — nothing changed.');
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

  const path = projectsConfigPath();
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
export async function run(argv: string[], binDir: string): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
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
      };
      try {
        return await runChatSetup({
          io: chatIo,
          ask: async (prompt) => {
            const result = await runClaude({ prompt, appendSystemPrompt: SETUP_SYSTEM }, () => {});
            return result.isError || !result.result ? null : result.result;
          },
          // After the fleet is written, build the whole deck layout in the same conversation:
          // pick a deck, generate the importable .streamDeckProfile, and open it — so `chat`
          // is a full talk-to-set-up flow, not just projects.json.
          onWritten: async (projects) => {
            chatIo.say('');
            await offerProfile(chatIo, process.cwd(), projects, defaultOpenFile());
          },
        });
      } catch {
        console.error('\nAborted — nothing written.');
        return 130;
      } finally {
        rl.close();
      }
    }
    case 'hooks':
      return runHooks(rest, binDir);
    case 'doctor':
      // `--json` for a copy-pasteable support bundle (also what the in-app "Copy diagnostics"
      // sends); the default is the human-readable report.
      console.log(rest.includes('--json') ? JSON.stringify(runDoctor(), null, 2) : formatReport(runDoctor()));
      return 0; // doctor is advisory — always exit 0
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
