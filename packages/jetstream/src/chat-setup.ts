import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { JetstreamConfig } from './config';
import { addToFleet, mergeFleet, writeFleetFile } from './fleet';
import { projectsConfigPath, readConfigFile , resolveProjectsConfigPath } from './projects-config';
import { DECK_MODELS, type DeckModel } from './profile';
import { NO_SETTINGS_TYPE_NAMES, resolvePlacements, type Placement } from './layout';
import { boardContext, renderBoardMap, type BoardLayout } from './board-layout';

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
  'live Claude Code status per project (working / needs you / done), plus usage and approval keys.',
  'Help the user build their fleet AND, when they ask, lay out their Stream Deck keys.',
  '',
  'Reply with EXACTLY ONE of:',
  '(a) A JSON object — no markdown, no prose — of this shape:',
  '    {"projects":[{"name":"Display name","path":"/absolute/repo/path"}],',
  '     "settings":{"theme":"default"|"highContrast","longPressMs":200-3000,',
  '                 "usageRefreshSec":15-3600,"escalateAfterSec":15-3600},',
  '     "layout":{"deck":"xl"|"standard"|"mini","keys":[',
  '        {"coord":"a8","type":"open-app","app":"/Applications/Telegram.app"}]}}',
  '    Include ONLY what the user asked for; omit "settings" and/or "layout" when not relevant.',
  '    "projects" may be [] when the user only asks for a key layout.',
  '  Coordinates: "a8" = row a (TOP) column 8 (RIGHT). Rows are letters a,b,c,… top→bottom;',
  '  columns are numbers 1..N left→right. XL is 8 cols × 4 rows, standard 5×3, mini 3×2.',
  '  Each key needs "coord" + "type". "type" is one of:',
  '    open-app {app:"/Applications/X.app"} · open-url {url:"https://…"} · run {command, args?} · slot (clear/empty)',
  '    text {text:"…"} · project {path, name?} · approve · deny · nav {target:"board"|"ops"}',
  `    ${NO_SETTINGS_TYPE_NAMES.join(' · ')}`,
  '  "icon" is the key\'s MAIN picture. An open-app key already auto-shows the app\'s own logo — do NOT set',
  '  "icon" to match it. Set "icon" only to REPLACE the picture: an image path ("icon":"/path/x.png") OR an',
  '  emoji ("icon":"🔥"). "glyph" is a SMALL badge in the corner, over the picture. So "change the icon to a',
  '  fire emoji" → {"icon":"🔥"}; "add a little bell badge" → {"glyph":"🔔"}.',
  '  ANY key also accepts: "color" (a name like red/green/purple or #rrggbb), "sub" (a small second line),',
  '  and "label" (rename).',
  '  To TWEAK or MOVE an existing key, re-emit that key with its shown type + fields PLUS your change',
  '  (e.g. add "color":"red"); to move, also emit {"coord":"<old>","type":"slot"} to clear the old spot.',
  '(b) ASK a clarifying question (prefix "QUESTION: ") whenever the request is genuinely AMBIGUOUS or',
  '    essential info is missing — i.e. the outcome would differ by the answer: which repo/path, which',
  '    coordinate, which of several keys they mean, or WHAT a key should do ("a selector" is unclear).',
  '    Prefer ONE focused question; you MAY ask a follow-up on a later turn. Do NOT ask about trivial',
  '    defaults you can reasonably infer (an exact colour shade, an obvious label) — pick a sensible one.',
  '',
  "Another Stream Deck plugin's action (Philips Hue, Spotify, OBS, Home Assistant, or any hardware /",
  'service integration) is NOT in the type list and you CANNOT place it — Jetstream only arranges its',
  'own keys plus the Elgato Text action. Do NOT dead-end by only asking for a command: reply with a',
  'QUESTION that (1) names the Stream Deck plugin for it and says to install it from the Elgato',
  "Marketplace and drag its action onto the coordinate, and (2) offers a `run` (a CLI/command) or",
  '`open-url` key there as the fallback if they have one. Place a `run` key only once they give the',
  'exact command (run keys are opt-in via "allowRunKeys").',
  'Never invent paths. Keep a home-relative path (~/dev/x) as the user gave it. Prefer their exact names.',
].join('\n');

export interface ChatIo {
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
  /** Optional interactive single-choice menu (arrow keys on a real TTY). When absent, the caller
   * falls back to a typed y/r/n via ask() — so piped input and the tests are unchanged. */
  select?: <T>(prompt: string, choices: { label: string; hint?: string; value: T }[]) => Promise<T>;
  /** Optional animated status while an async op runs; returns a stop fn. Absent → a static line. */
  spinner?: (label: string) => () => void;
}

export interface ChatDeps {
  io: ChatIo;
  /** Send a full prompt to the model, get its reply text — or null on an agent error (e.g.
   * `claude` not installed). Injected so tests never spawn a real model. */
  ask: (prompt: string) => Promise<string | null>;
  configPath?: string;
  /** Injected in tests; defaults to the atomic projects.json writer. */
  write?: (projects: ProjectConfig[], settings: Partial<JetstreamConfig>) => void;
  /** Optional post-write hook (e.g. offer to generate the importable fleet profile). */
  onWritten?: (projects: ProjectConfig[]) => Promise<void>;
  /** Optional hook when the model designed a full key layout: generate the importable profile. */
  onLayout?: (layout: NonNullable<Proposal['layout']>) => Promise<void>;
  /** The user's current board — shown at start + given to the model so it can edit by coordinate. */
  board?: BoardLayout | null;
  /** Optional coordinate painter for the board map (e.g. colour by row); identity when absent. */
  paintCoord?: (coord: string, row: number) => string;
  /** Preflight: is `claude` available on PATH? When it returns false, chat fails fast with an
   * actionable hint BEFORE the first typed turn, instead of only discovering it after a full
   * round-trip. Injected (cli passes commandOnPath) so this module stays free of PATH/exec deps;
   * absent → skip the check (keeps the pure tests unchanged). */
  claudeAvailable?: () => boolean;
}

export interface Proposal {
  projects: ProjectConfig[];
  settings: Partial<JetstreamConfig>;
  /** An optional full-board layout the model designed: which key sits at which coordinate.
   * `dropped` = proposed keys resolvePlacements refused (unknown type, off-board, dup, bad settings);
   * a partial layout is destructive to APPLY (a move whose destination was dropped still clears its
   * source), so the apply flow refuses when `dropped > 0`. */
  layout?: { deck: DeckModel; placements: Placement[]; warnings: string[]; dropped: number };
}

/** The clarifying question in an agent reply, or null if the reply isn't one. */
export function clarifyingQuestion(reply: string): string | null {
  const match = /^QUESTION:\s*(.+)/is.exec(reply.trim());
  return match?.[1]?.trim() ?? null;
}

/** Show an animated "thinking…" while the model responds (a real spinner on a TTY), or a static line
 * when no spinner is wired (tests, piped input). Returns a stop fn to call when the reply lands. */
function startThinking(io: ChatIo): () => void {
  if (io.spinner) return io.spinner('thinking…');
  io.say('  (thinking…)');
  return () => {};
}

/** Map a typed y/r/n answer (the no-menu fallback) to a decision: n/no/cancel → cancel, y/yes →
 * apply, anything else → refine (unchanged from the original prompt's behaviour). */
function normalizeDecision(d: string): 'apply' | 'refine' | 'cancel' {
  if (d === 'n' || d === 'no' || d === 'cancel') return 'cancel';
  if (d === 'y' || d === 'yes') return 'apply';
  return 'refine';
}

/** Parse the agent's JSON reply into a VALIDATED proposal, or null if it isn't a fleet
 * (bad JSON, no projects). Paths run through addToFleet so they're canonicalized, deduped,
 * and named exactly like the wizard and PI paths — the model can't smuggle in a malformed
 * entry. Settings are type-checked here; ranges are clamped at plugin load (mergeConfig). */
export function parseProposal(reply: string, defaultDeck?: DeckModel): Proposal | null {
  const parsed = parseJsonObject(reply);
  if (parsed === null) return null;
  const raw = parsed as { projects?: unknown; settings?: unknown; layout?: unknown };
  // "projects" is OPTIONAL — a layout-only request ("add a key at a8") legitimately omits it.
  let projects: ProjectConfig[] = [];
  if (Array.isArray(raw.projects)) {
    for (const entry of raw.projects) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as { name?: unknown; path?: unknown };
      if (typeof e.path !== 'string' || e.path.trim() === '') continue;
      projects = addToFleet(projects, {
        path: e.path,
        name: typeof e.name === 'string' ? e.name : undefined,
      }).projects;
    }
  }
  const layout = extractLayout(raw.layout, defaultDeck);
  const settings = extractSettings(raw.settings);
  // Nothing usable — no fleet, no layout, no settings — so it isn't a proposal. SETTINGS COUNT:
  // "turn on high contrast" is a flow SETUP_SYSTEM explicitly advertises, and it legitimately comes
  // back as {"projects":[],"settings":{…}}. Ignoring that told the user their correct request was
  // unreadable input.
  if (projects.length === 0 && !layout && Object.keys(settings).length === 0) return null;
  return { projects, settings, ...(layout ? { layout } : {}) };
}

/** Pull a JSON object out of a model reply — the whole trimmed string when it's clean JSON, else the
 * first `{`…last `}` block (the model sometimes wraps its JSON in prose or a ```json fence). Null if
 * neither parses to a plain object. */
function parseJsonObject(reply: string): Record<string, unknown> | null {
  const text = reply.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidates = start >= 0 && end > start ? [text, text.slice(start, end + 1)] : [text];
  for (const candidate of candidates) {
    try {
      const v: unknown = JSON.parse(candidate);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Resolve the model's proposed `layout` ({deck, keys:[{coord,type,…}]}) into VALIDATED placements,
 * or undefined when there's no usable layout — mirrors extractSettings' whitelist stance
 * (resolvePlacements drops anything malformed; the model can't smuggle a bad key onto the deck). */
function extractLayout(raw: unknown, defaultDeck?: DeckModel): Proposal['layout'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const l = raw as { deck?: unknown; keys?: unknown };
  // Fall back to the current board's deck when the model omits or mistypes "deck".
  const deck = DECK_MODELS.find((d) => d.key === l.deck) ?? defaultDeck;
  if (!deck) return undefined;
  const { placements, warnings } = resolvePlacements(deck, l.keys);
  // Count keys resolvePlacements refused. Not all drops warn (a non-object entry is skipped silently),
  // so derive it from the input count, not warnings.length.
  const inputCount = Array.isArray(l.keys) ? l.keys.length : 0;
  // No keys at all → not a layout. But keep a layout where keys were PROPOSED yet ALL dropped, so its
  // dropped>0 still reaches the apply-flow's refusal (else a mixed proposal would silently apply the
  // projects and ignore the requested — possibly destructive — layout).
  if (placements.length === 0 && inputCount === 0) return undefined;
  const dropped = Math.max(0, inputCount - placements.length);
  return { deck, placements, warnings, dropped };
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
  // Fail fast when `claude` isn't installed: chat is one `claude -p` per turn, so without it every
  // turn would spin then fail. Catch it before the first prompt instead of after a wasted round-trip.
  if (deps.claudeAvailable && !deps.claudeAvailable()) {
    io.say(
      'chat needs Claude Code (`claude`) on your PATH, and it isn\'t there. Install it and log in, ' +
        'or run `jetstream init` for the guided wizard instead.',
    );
    return 1;
  }
  const configPath = deps.configPath ?? resolveProjectsConfigPath();
  const write = deps.write ?? ((p, s) => writeFleetFile(configPath, p, s));

  io.say('Jetstream chat setup — describe your repos to build your fleet, or arrange your deck by coordinate.');
  io.say('  e.g. "3 repos in ~/dev: falcon, api, web"  ·  "add an open-Telegram key at a8"  ·  "move usage to b1"');
  io.say('  (type "cancel" to quit)');
  if (deps.board) {
    io.say(`\nYour current board (${deps.board.deck.label}):`);
    io.say(renderBoardMap(deps.board, deps.paintCoord));
    io.say('  Refer to keys by coordinate, e.g. "replace a8 with an open-Telegram key".');
  }

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

    const firstCtx = deps.board ? `${boardContext(deps.board)}\n\n` : '';
    const prompt = transcript ? `${transcript}\nUser: ${message}` : `${firstCtx}${message}`;
    const stopThinking = startThinking(io);
    let reply: string | null;
    try {
      reply = await deps.ask(prompt);
    } finally {
      stopThinking();
    }
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

    const proposal = parseProposal(reply, deps.board?.deck);
    if (
      !proposal ||
      (proposal.projects.length === 0 &&
        !proposal.layout &&
        Object.keys(proposal.settings).length === 0)
    ) {
      io.say("\n(couldn't read a fleet or layout from that — give me repo paths, or which keys go where.)");
      continue;
    }

    if (proposal.projects.length > 0) {
      io.say('\nProposed fleet:');
      for (const project of proposal.projects) io.say(`  • ${project.name} — ${project.path}`);
    }
    if (Object.keys(proposal.settings).length > 0) {
      io.say(`  settings: ${JSON.stringify(proposal.settings)}`);
    }
    if (proposal.layout) {
      io.say(`  layout: ${proposal.layout.placements.length} key(s) on the ${proposal.layout.deck.label}`);
      for (const w of proposal.layout.warnings) io.say(`    ⚠ ${w}`);
    }
    // Refuse a PARTIAL layout. Applying it is destructive: a move whose destination key was dropped
    // still clears/overwrites its source, silently DELETING it (how a "move micmute to d2" that the
    // build couldn't place ended up erasing micmute). Loop for a corrected instruction instead.
    if (proposal.layout && proposal.layout.dropped > 0) {
      io.say(
        `\n⚠ ${proposal.layout.dropped} key(s) couldn't be placed — NOT applying, since a partial move ` +
          `can delete the keys it can't relocate. Tell me a corrected version (or a supported key type).`,
      );
      continue;
    }

    const decision = io.select
      ? await io.select('Apply this?', [
          { label: 'Apply', hint: 'write it to your deck', value: 'apply' as const },
          { label: 'Refine', hint: 'describe a change', value: 'refine' as const },
          { label: 'Cancel', hint: 'discard', value: 'cancel' as const },
        ])
      : normalizeDecision((await io.ask('\nApply? [y = write · r = refine · n = cancel]: ')).trim().toLowerCase());
    if (decision === 'cancel') {
      io.say('Cancelled — nothing written.');
      return 0;
    }
    if (decision === 'apply') {
      let applied = 0;
      let wroteSettings = false;
      let fleet = proposal.projects;
      try {
        // MERGE with what is already on disk. The model is shown the board, not the fleet, and is
        // told to include only what the user asked for — so "add /repo/new" arrives as a
        // one-project proposal. Writing it verbatim replaced the whole fleet, silently turning an
        // add into a wipe. Absence is the model's shorthand, never a removal.
        const current = readConfigFile(configPath);
        // NEVER write over a fleet we failed to read. `corrupt` means the file EXISTS but could not
        // be parsed, so `current.projects` is [] — not because the fleet is empty, but because we
        // could not see it. Merging into that and writing would replace a populated projects.json
        // with whatever the proposal held (for a settings-only proposal: nothing at all).
        if (current.corrupt) {
          io.say(
            `\n${configPath} exists but could not be parsed, so nothing was written — fix or remove it first.`,
          );
          return 1;
        }
        if (proposal.projects.length > 0 || Object.keys(proposal.settings).length > 0) {
          const merged = mergeFleet(current.projects, proposal.projects);
          // Settings MERGE over what's on disk. renderProjectsJson writes the settings block
          // wholesale, so passing only the proposal's keys erased every setting the model didn't
          // happen to re-emit — and gating the write on `projects.length > 0` meant settings the
          // user had just approved were shown, confirmed, and silently dropped.
          write(merged, { ...current.settings, ...proposal.settings });
          applied = merged.length;
          fleet = merged;
          wroteSettings = Object.keys(proposal.settings).length > 0;
        }
      } catch (error) {
        io.say(`Couldn't write the config: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      if (applied > 0) io.say(`\nWrote ${applied} project(s) to ${configPath}.`);
      else if (wroteSettings) io.say(`\nUpdated settings in ${configPath}.`);
      // A designed layout → generate the importable profile; otherwise the fleet path offers the
      // ready-made board layout, falling back to the drag-keys hint.
      if (proposal.layout && deps.onLayout) await deps.onLayout(proposal.layout);
      // The MERGED fleet, not just the proposal — otherwise the generated profile carries keys for
      // only the repo that was added and silently omits the seven already there.
      else if (deps.onWritten) await deps.onWritten(fleet);
      else io.say('Next: drag a Fleet + Attention key onto your deck.');
      return 0;
    }
    // Anything else = refine: loop, the transcript carries the last proposal.
    io.say('OK — tell me what to change.');
  }
  io.say("Setup didn't converge — run `jetstream init` for the step-by-step wizard.");
  return 0;
}
