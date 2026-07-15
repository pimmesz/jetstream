# Jetstream — SPEC (v1)

**A physical command board for Claude Code across all your projects.** One Stream Deck key per
project; each glows with that project's live Claude status — grey (no session), blue (idle), **red
(working)**, **amber (needs you)**, **green (done)** — and pressing it jumps you into that project.
Plus a "needs you" doorbell and a usage gauge. It reads status from Claude Code lifecycle hooks, so
it works for the interactive sessions you actually run all day, not just headless launches.

Standalone — no afterburner required; afterburner is just one of the projects on the board.

Status: **BUILT (v1.3 + item G, plus the post-G wave below).** Cores + plugin unit-tested (see
`pnpm test` for the live count), passes `streamdeck validate`, packs.
v1.1 added deck **Approve/Deny** + **interrupt**; v1.2 added **colour-blind glyphs + high-contrast
theme**, a **Settings** key (global settings: theme / escalation / long-press / usage-refresh),
**escalation flash** on the doorbell, **`done Xm`** waiting time, **opt-in tool detail**
(`--tool-detail` → `Bash · 12m`), and **cost** on Launch results. v1.3 added a **Fleet roll-up**
key, a **diff-size badge** on done keys (`+120/-40 · done Xm`), an **approve-vs-answer split** on
amber keys (deck-answerable `!` vs keyboard-only `?`), a longer/legible **permission-command line**,
a labelled **sooner-of 5h/7d reset** on the gauge, and **multi-action support** on Launch. v1.3
**item G** added the consolidated **`jetstream` CLI** (`hooks install` / `doctor` / `setup`) and
**config-file projects** — a `projects.json` that seeds the board's fleet (so Fleet + Attention cover
repos without a placed key) plus an optional settings preset. The plugin also **auto-wires its status + permission hooks on first launch** (`autoWireHooks`:
a config-dir marker makes it truly once so manual removal sticks; same-script hook entries are
refreshed across node-runtime changes, never duplicated; non-fatal; the statusline stays CLI-only),
so a fresh install lights up with no terminal step; the CLI `setup` stays for the `projects.json`
template and manual re-wiring. On top sits
**`jetstream init`** (init.ts) — the guided wizard (repos via scan or path-by-path, theme, timings →
projects.json + hooks) — and an optional **prebuilt key layout** (profile.ts): a generated
`.streamDeckProfile` (flat `Version:"1.0"` manifest + dependency-free STORE zip, mirroring the profiles
Elgato's own tutorial plugin ships; DeviceModel codes taken from those artifacts) for Mini/MK.2/XL,
imported additively via double-click.

Shipped since item G: **`jetstream chat`** (chat-setup.ts + the CLI's `chat` command) — conversational
setup: describe your repos in plain English, Claude returns a structured proposal, the code validates
it through the same fleet rules as the wizard and writes projects.json (the model never touches disk),
then offers the generated key layout in the same conversation; a **two-page bundled deck**
(profile.ts) — a **Board** page (status keys) and an **Ops** page (controls) ship in the manifest's
`Profiles` for Mini/MK.2/XL, linked by a **page-nav key** (nav.ts); the **CI / PR status key** (ci.ts —
no longer v2); the formerly-deferred **Stream Deck + dial** (dial.ts + encoder.ts); the Ops-page
control keys — **afterburner heartbeat** (heartbeat.ts), **review queue** (review.ts), **model toggle**
(model.ts), and **stop-all** (interrupt-all.ts) — see the Ops-page table below;
**live-process session discovery** (discover.ts) + **board restart-persistence** (state.ts) — see the
status section; and the `projects.json`↔placed-key overlap fix (state.ts `projects()`: a placed key
suppresses a seed claiming the same path and overrides by id, so a repo never shows twice — deck
wins). Pressing a Project key now opens the project folder **in your editor** (switchto.ts:
VS Code → Cursor → `$EDITOR`, else the OS opener — no shell, no terminal, never launches `claude`),
replacing the planned jump-to-terminal UX. Remaining: on-device verification (a real deck + real
`~/.claude/settings.json`) and the Windows gaps (interrupt + process discovery are macOS/Linux-only;
the editor/folder open works everywhere).

## The board (v1 key set)

| Key                    | Face / colour                                                                                        | Press                                                                                             | Backed by                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Project** (one each) | name + live colour: grey none · blue idle · **red working** (+ elapsed) · **amber needs you** (`!` deck-answerable / `?` keyboard) · **green done** (`+120/-40 · done Xm`) | switch to it — open the project folder in an auto-detected editor (VS Code → Cursor → `$EDITOR`, else the OS opener) | `status` reducer ← hooks           |
| **Fleet** roll-up      | one always-visible key: `3w 1! 2✓` counts, coloured by the WORST state present (needsInput > working > done) | lit board: ack blip · dark board: shows why (`add repos` / `wire hooks` / `all idle`)             | `status.summarize`/`worstStatus`   |
| **Attention** doorbell | dim; lights **amber** and names the project when ANY project needs input                              | jump to that project                                                                              | `status.needsAttention`            |
| **Usage** gauge        | 5h / 7d used %, sooner-of reset countdown                                                             | (read-only)                                                                                        | `usage.resolveUsage`               |
| **CI / PR** status     | worst CI state across the fleet's open `afterburner/` PRs — green / red / running; flashes on a new failure | (read-only)                                                                                        | `ci-status` (`gh` poll)            |
| **Launch preset**\*    | a canned prompt / skill for a chosen project                                                          | fire headless `claude -p`, stream idle→working→done onto the key                                  | `claude.runClaude`                 |

\* optional in v1. Projects are user-configured `{ id, name, path }` — whatever repos you run
Claude in; each Project key's settings panel takes a name + path.

**Deck approvals (v1.1):** you CAN approve/deny a permission prompt from the deck. Claude's
`PermissionRequest` hook is synchronous, so Jetstream's hook holds its response open until an
**Approve** or **Deny** key is pressed (or ~90s passes, after which Claude shows its normal dialog).
Place one Approve key + one Deny key; they act on the oldest pending request. You still can't answer
a free-text question or drive the TUI — for those, amber = "go to your keyboard," and the press gets
you there. **Interrupt (v1.1):** long-press a Project key to SIGINT its running Claude session (the
lifecycle hook reports its parent PID for this).

## The Ops page (post-item-G key set)

The bundled deck is two pages — **Board** (the keys above) and **Ops** (controls) — linked by a
**Nav** key (nav.ts) that flips the device between the bundled Board/Ops profiles (Standard + XL;
the Mini has no room for a second page). Heartbeat and Review need the separate `afterburner` CLI
and show an explicit "no afterburner" face without it; both no-op (never spawn) when unplaced.

| Key                    | Face / colour                                                                     | Press                                                                          | Backed by                     |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| **Heartbeat**          | `armed live` / `dry-run` / `idle`, plus `N benched` (failure-backoff)             | short: re-poll · long: fire a cycle (`afterburner run-once`)                    | `afterburner status --json`   |
| **Review** queue       | `N PRs · M ✓` — green when a PR is ready (CI green or nothing to wait on)          | open the top ready PR in the browser — deliberately open-only, never merge      | `afterburner review --json`   |
| **Model** toggle       | the global Launch-model override: `default` → `opus` → `sonnet` → `haiku`          | cycle it (Launch keys without their own model pick it up live)                  | Stream Deck global settings   |
| **Stop all**           | `N working` — red while anything runs                                              | SIGINT every running Claude session across the fleet (the panic key)            | `board.allPids()` + switchto  |
| **Fleet dial** (SD +)  | touchscreen: the selected project's name + live status line                        | rotate scrubs the fleet · tap / short press opens it · long press interrupts    | encoder.ts (dial.ts is glue)  |

The **Fleet dial** (dial.ts) is the Stream Deck + encoder take on the board: one dial to scan the
whole fleet without a key per repo, mirroring the keypad Project key's press semantics. Encoder-only —
the keypad board already covers non-+ decks (which is also why the + has no bundled profile pages).

## How per-project status works (the hero mechanism)

Claude Code hooks fire during **every** session (interactive included) and can run a command. Install
Jetstream's hook globally in `~/.claude/settings.json` for `SessionStart` / `UserPromptSubmit` /
`Notification` / `Stop` / `SessionEnd` (etc.); each fires `jetstream-status-hook`, which POSTs the
payload (carrying `cwd` + `session_id`) to the plugin's **local HTTP server**. The `status` reducer
maps events → per-session status, `matchProject(cwd)` routes a session to its project key, and
`statusByProject` aggregates (needsInput > working > done > idle) into the key colour. The hook is
**silent** (prints nothing — some hooks treat stdout as injected context) and always exits 0, so it
can never disturb a session.

Two shipped reinforcements keep the board truthful when hooks alone can't. **Live-process discovery**
(discover.ts): a 5s `ps` + `lsof` poll (macOS/Linux; no-op on Windows) fills in projects whose hooks
are SILENT — a live session shows **working** (CPU-burning) or **idle** even when its events predate
this plugin instance; hooks stay authoritative and upgrade to the precise state as events arrive.
**Restart persistence** (state.ts): the board checkpoints to `~/.jetstream/board-state.json` on every
event, and on startup restores it reconciled against actually-running processes — a still-running
session re-shows immediately (with a live PID for interrupt), a finished one stays grey (no
resurrected "working"), and an ambiguous cwd is left to hooks/discovery. Both are best-effort and
non-fatal.

## Verified capability matrix (re-verify at build — these change)

Sources: Claude Code headless/sessions/hooks/statusline docs; `@elgato/streamdeck` 2.1.0
(Node ≥ 20.5.1); `@elgato/cli` 1.7.4 (`streamdeck` CLI: create / link / restart / pack / validate).

**Feasible:** launch one-shot `claude -p` (model, permission-mode, allowedTools, append-system-
prompt; prompt via **stdin**); stream `--output-format stream-json`; `session_id`/`result`/`is_error`
from the result event; `--continue` / `--resume <id|name>` / `--fork-session`; skills in a `-p`
prompt; **lifecycle hooks → local server** (the status mechanism above); usage via a **statusline
hook** captured to a cache the plugin reads.

**NOT feasible (confirmed):** driving/answering a running interactive TUI from outside; reading usage
from a Claude-owned file (a statusline hook must capture it); treating `~/.claude/projects/*.jsonl` as
a stable API.

## Cost & auth (load-bearing)

A keypress must **not** silently bill the metered API. Run under the **subscription login**; **strip
`ANTHROPIC_API_KEY`** from every spawned process (`claude.sanitizeEnv` does this); prefer
`CLAUDE_CODE_OAUTH_TOKEN` for headless. The **5h/7d gauge** shows interactive usage; headless
`claude -p` launches draw a **separate** Agent-SDK allotment — a launch key does not move the gauge.
Default execution = `claude -p` subprocess; the Agent SDK is opt-in only if confirmed on subscription
auth (else it bills the API — label loudly). **BUILD VERIFY the metering before wiring any SDK path.**

## Architecture (monorepo, under afterburner's `packages/`)

- **`packages/usage`** — BUILT (12 tests). Reads Claude/Codex usage into a typed `UsageFeed`; ships a
  statusline hook that captures it to a cache the reader/resolver reads. Node built-ins only.
- **`packages/claude`** — BUILT (9 tests). Drives `claude -p`: pure `buildArgs`, `sanitizeEnv`
  (strips the API key), `parseStreamLine`, and `runClaude` (injectable spawn). Node built-ins only.
- **`packages/status`** — BUILT (9 tests). The hero core: `parseHookPayload`, `matchProject`,
  `reduce`, `statusByProject`, `needsAttention`, `colorFor`, + the silent lifecycle hook that POSTs
  to the plugin. Pure reducer + a thin hook. Node built-ins only.
- **`packages/jetstream`** — BUILT. The `@elgato/streamdeck` plugin: `<uuid>.sdPlugin` +
  `manifest.json`, one `SingletonAction` per key type (project / fleet / attention / usage / CI /
  launch / approve-deny / settings / nav / model / review / heartbeat / stop-all, plus the SD+ fleet
  dial), the **local HTTP hook-listener server** feeding the `status` reducer, key rendering (colour +
  label + elapsed), the switch/launch actions, the consolidated **`jetstream` CLI** (`init` — the
  guided wizard: projects.json + hooks + an optional prebuilt key layout; `chat` — the conversational
  setup: the model proposes, the code validates + writes, then offers the layout; `hooks install`
  writes the global hook + statusline hook into `~/.claude/settings.json`; `doctor` is a read-only
  health check; `setup` does hooks + a `projects.json` template), the bundled two-page Board/Ops
  profiles (profile.ts), and startup **`projects.json`** seeding of the board's fleet. Depends on the
  three cores via `workspace:*`.
  Distribution is **CLI-first**: the packed plugin (UUID `gg.pim.jetstream`) is bundled into the
  `@pimmesz/afterburner` npm package and installed with `afterburner jetstream install`. The Elgato
  Marketplace is a parked/later discovery channel, not the primary path.

afterburner is **not** a dependency — it's just a project path on the board. (`usage` can shell out to
`afterburner statusline print --json` as an optional fallback when present, nothing more.)

Gate: each package has its own `typecheck`/`test`/`check`; afterburner's root gate is scoped away from
`packages/` (proven green), so it stays independent. Add a `packages-ci.yml`; do **not** edit
afterburner's `ci.yml`. Changesets only when a package publishes to npm (deferred — ships via Elgato).

## Open items to verify during PHASE 2

- The exact `stream-json` assistant-text event schema (`result` is handled; text extraction is
  best-effort in `claude.parseStreamLine`).
- The Agent-SDK metering question (subscription vs API).
- The Claude hook payload field names (`hook_event_name`, `cwd`, `session_id`) + the settings.json
  hook config format for each event (`status.parseHookPayload` is defensive, so a shape change
  degrades rather than crashes).
- The statusline usage payload field names (`rate_limits.five_hour.used_percentage` / `resets_at`).

Resolved since: switching shipped as open-in-editor (switchto.ts — no terminal focus/`--continue`
launch); the npm scope (`@pimmesz/*`), plugin UUID (`gg.pim.jetstream`), and server port
(`JETSTREAM_PORT`, default 41321 in server.ts) are final; and the `projects.json` ↔ placed-key merge
landed in state.ts `projects()` (deck wins: placed keys override by id, and a seed whose path a
placed key claims is suppressed).
