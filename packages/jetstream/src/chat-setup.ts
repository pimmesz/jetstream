import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { JetstreamConfig } from './config';
import { addToFleet, writeFleetFile } from './fleet';
import { projectsConfigPath } from './projects-config';

/**
 * `jetstream chat` — a CONVERSATIONAL alternative to the step-by-step `init` wizard: describe
 * your repos + how you work in plain English and the model turns it into a validated fleet
 * (projects.json). Deliberately controlled, not an open agent: the model only ever RETURNS a
 * structured proposal; this code validates it (through the same tested fleet rules the wizard
 * uses) and writes the file — the model never touches disk. Uses the Claude subscription (the
 * plugin's claude backend, API key stripped). The LLM call is injected so it's unit-testable
 * without spawning `claude`.
 */

export const SETUP_SYSTEM = [
  'You are the Jetstream setup assistant. Jetstream is an Elgato Stream Deck plugin that shows',
  'live Claude Code status per project (working / needs you / done), plus usage and launch keys.',
  'Help the user build their fleet from a plain-English description of their repos and workflow.',
  '',
  'Reply with EXACTLY ONE of:',
  '(a) A JSON object — no markdown, no prose — of this shape:',
  '    {"projects":[{"name":"Display name","path":"/absolute/repo/path"}],',
  '     "settings":{"theme":"default"|"highContrast","longPressMs":200-3000,',
  '                 "usageRefreshSec":15-3600,"escalateAfterSec":15-3600}}',
  '    Include ONLY settings the user actually asked to change; omit the rest (omit "settings" if none).',
  '(b) If essential info is missing (e.g. no repo paths), a single clarifying question prefixed',
  '    "QUESTION: ".',
  'Never invent paths. Keep a home-relative path (~/dev/x) as the user gave it. Prefer their exact names.',
].join('\n');

export interface ChatIo {
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
}

export interface ChatDeps {
  io: ChatIo;
  /** Send a full prompt to the model, get its reply text — or null on an agent error (e.g.
   * `claude` not installed). Injected so tests never spawn a real model. */
  ask: (prompt: string) => Promise<string | null>;
  configPath?: string;
  /** Injected in tests; defaults to the atomic projects.json writer. */
  write?: (projects: ProjectConfig[], settings: Partial<JetstreamConfig>) => void;
  /** Optional post-write hook (e.g. offer to generate the importable profile). */
  onWritten?: (projects: ProjectConfig[]) => Promise<void>;
}

export interface Proposal {
  projects: ProjectConfig[];
  settings: Partial<JetstreamConfig>;
}

/** The clarifying question in an agent reply, or null if the reply isn't one. */
export function clarifyingQuestion(reply: string): string | null {
  const match = /^QUESTION:\s*(.+)/is.exec(reply.trim());
  return match?.[1]?.trim() ?? null;
}

/** Parse the agent's JSON reply into a VALIDATED proposal, or null if it isn't a fleet
 * (bad JSON, no projects). Paths run through addToFleet so they're canonicalized, deduped,
 * and named exactly like the wizard and PI paths — the model can't smuggle in a malformed
 * entry. Settings are type-checked here; ranges are clamped at plugin load (mergeConfig). */
export function parseProposal(reply: string): Proposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as { projects?: unknown; settings?: unknown };
  if (!Array.isArray(raw.projects)) return null;
  let projects: ProjectConfig[] = [];
  for (const entry of raw.projects) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { name?: unknown; path?: unknown };
    if (typeof e.path !== 'string' || e.path.trim() === '') continue;
    projects = addToFleet(projects, {
      path: e.path,
      name: typeof e.name === 'string' ? e.name : undefined,
    }).projects;
  }
  return { projects, settings: extractSettings(raw.settings) };
}

function extractSettings(raw: unknown): Partial<JetstreamConfig> {
  if (typeof raw !== 'object' || raw === null) return {};
  const s = raw as Record<string, unknown>;
  const out: Partial<JetstreamConfig> = {};
  if (s.theme === 'default' || s.theme === 'highContrast') out.theme = s.theme;
  for (const key of ['longPressMs', 'usageRefreshSec', 'escalateAfterSec'] as const) {
    const value = s[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const MAX_TURNS = 12; // a bound so a non-converging conversation can't loop forever

/** Run the conversational setup. Returns a process exit code. */
export async function runChatSetup(deps: ChatDeps): Promise<number> {
  const { io } = deps;
  const configPath = deps.configPath ?? projectsConfigPath();
  const write = deps.write ?? ((p, s) => writeFleetFile(configPath, p, s));

  io.say("Jetstream chat setup — describe your repos and how you work; I'll build your fleet.");
  io.say('  e.g. "3 repos in ~/dev: falcon, api, web. High-contrast theme, interrupt after 800ms."');
  io.say('  (type "cancel" to quit)');

  let transcript = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const message = (await io.ask('\nyou: ')).trim();
    if (message === '') {
      io.say('(nothing entered — describe your repos, or type "cancel")');
      continue;
    }
    if (/^(cancel|quit|exit)$/i.test(message)) {
      io.say('Cancelled — nothing written.');
      return 0;
    }

    const prompt = transcript ? `${transcript}\nUser: ${message}` : message;
    io.say('  (thinking…)');
    const reply = await deps.ask(prompt);
    if (reply === null) {
      io.say('The assistant is unavailable — is `claude` installed and logged in? Try `jetstream init` instead.');
      return 1;
    }
    transcript = `${prompt}\nAssistant: ${reply}`;

    const question = clarifyingQuestion(reply);
    if (question) {
      io.say(`\n${question}`);
      continue;
    }

    const proposal = parseProposal(reply);
    if (!proposal || proposal.projects.length === 0) {
      io.say("\n(couldn't read a fleet from that — tell me the repo names and their paths.)");
      continue;
    }

    io.say('\nProposed fleet:');
    for (const project of proposal.projects) io.say(`  • ${project.name} — ${project.path}`);
    if (Object.keys(proposal.settings).length > 0) {
      io.say(`  settings: ${JSON.stringify(proposal.settings)}`);
    }

    const decision = (await io.ask('\nApply? [y = write · r = refine · n = cancel]: ')).trim().toLowerCase();
    if (decision === 'n' || decision === 'no' || decision === 'cancel') {
      io.say('Cancelled — nothing written.');
      return 0;
    }
    if (decision === 'y' || decision === 'yes') {
      try {
        write(proposal.projects, proposal.settings);
      } catch (error) {
        io.say(`Couldn't write the config: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      io.say(`\nWrote ${proposal.projects.length} project(s) to ${configPath}.`);
      // onWritten (when wired) offers a ready-made layout to import and prints how; fall back to
      // the drag-keys hint for the bare fleet-only path.
      if (deps.onWritten) await deps.onWritten(proposal.projects);
      else io.say('Next: drag a Fleet + Attention key onto your deck.');
      return 0;
    }
    // Anything else = refine: loop, the transcript carries the last proposal.
    io.say('OK — tell me what to change.');
  }
  io.say("Setup didn't converge — run `jetstream init` for the step-by-step wizard.");
  return 0;
}
