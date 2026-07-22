# Jetstream — SPEC (v1)

**A physical command board for Claude Code across all your projects.** One Stream Deck key per
project; each glows with that project's live Claude status — grey (no session), blue (idle), **red
(working)**, **amber (needs you)**, **green (done)** — and pressing it jumps you into that project.
Plus a "needs you" doorbell and a usage gauge. It reads status from Claude Code lifecycle hooks, so
it works for the interactive sessions you actually run all day.

Standalone — it works with Claude Code alone; no other tooling required.

Status: **BUILT (v1.3 + item G, plus the post-G wave below).** Cores + plugin unit-tested (see
`pnpm test` for the live count), passes `streamdeck validate`, packs.
v1.1 added deck **Approve/Deny** + **interrupt**; v1.2 added **colour-blind glyphs + high-contrast
theme**, a **Settings** key (global settings: theme / escalation / long-press / usage-refresh),
**escalation flash** on the doorbell, **`done Xm`** waiting time, **opt-in tool detail**
(`--tool-detail` → `Bash · 12m`), and **cost** on Launch results (Launch has since been removed —
see the removals note below). v1.3 added a **Fleet roll-up**
key, a **diff-size badge** on done keys (`done Xm · +120/-40`), an **approve-vs-answer split** on
amber keys (deck-answerable `!` vs keyboard-only `?`), a longer/legible **permission-command line**,
and a labelled **sooner-of 5h/7d reset** on the gauge. v1.3
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
`Profiles` for Mini/MK.2/XL, linked by a **page-nav key** (nav.ts); the formerly-deferred
**Stream Deck + dial** (dial.ts + encoder.ts); the Ops-page control key **stop-all**
(interrupt-all.ts) — see the Ops-page table below;
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
| **Project** (one each) | name + live colour: grey none · blue idle · **red working** (+ elapsed) · **amber needs you** (`!` deck-answerable / `?` keyboard) · **green done** (`done Xm · +120/-40`) · **magenta failed** (`✕`, `failed Xm` — the API killed the turn) | switch to it — open the project folder in an auto-detected editor (VS Code → Cursor → `$EDITOR`, else the OS opener) | `status` reducer ← hooks           |
| **Fleet** roll-up      | one always-visible key: `3w 1! 2✓` counts, coloured by the WORST state present (needsInput > failed > working > done) | lit board: ack blip · dark board: shows why (`add repos` / `wire hooks` / `all idle`)             | `status.summarize`/`worstStatus`   |
| **Attention** doorbell | dim; lights **amber** (needs input) or **magenta** (a died turn) and names the project              | jump to that project                                                                              | `status.needsAttention`            |
| **Usage** gauge        | 5h / 7d used %, sooner-of reset countdown                                                             | (read-only)                                                                                        | `usage.resolveUsage`               |

Projects are user-configured `{ id, name, path }` — whatever repos you run
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
the Mini has no room for a second page).

| Key                    | Face / colour                                                                     | Press                                                                          | Backed by                     |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| **Stop all**           | `N working` — red while anything runs                                              | SIGINT every running Claude session across the fleet (the panic key)            | `board.allPids()` + switchto  |
| **Fleet dial** (SD +)  | touchscreen: the selected project's name + live status line                        | rotate scrubs the fleet · tap / short press opens it · long press interrupts    | encoder.ts (dial.ts is glue)  |

The **Fleet dial** (dial.ts) is the Stream Deck + encoder take on the board: one dial to scan the
whole fleet without a key per repo, mirroring the keypad Project key's press semantics. Encoder-only —
the keypad board already covers non-+ decks (which is also why the + has no bundled profile pages).

## Removed since v1.5 (do not re-propose)

Three keys shipped and were then taken back out, so this spec no longer describes them: the
**CI / PR status** key (`ci.ts` + `ci-status.ts`, the only thing that made the `gh` CLI a runtime
dependency, plus the `ciBranchPrefix` setting), the **Launch preset** key (`launch.ts`, headless
`claude -p`, plus the `launchModel` setting) and the **Model toggle** (`model.ts`), which existed
only to feed Launch. v1.5.0 had already removed the **afterburner** integration and the
**heartbeat** + **review** keys. `packages/jetstream/docs/v2-roadmap.md` carries the rationale.

## The `failed` status

A turn the API kills — overloaded, rate_limit, billing_error, authentication_failed — fires the
**`StopFailure`** hook INSTEAD of `Stop`. Without it the session stays pinned `working` until the
20-minute stall glyph gives up, so the board cannot tell "finished" from "died" — the one
distinction it exists to make. `StopFailure` is in `HOOK_EVENTS` (hooks-install.ts) and the
auto-wire `WIRE_VERSION` was bumped to 4 so existing installs actually receive it. The status
ranks above `working`/`done`, rings the doorbell, counts in the roll-up, survives a restart
(state.ts's restore whitelist), and paints magenta `#d6409f` with a `✕` glyph — deliberately
neither the working orange nor the red reserved for deny/stop.

## The loopback token

The hook listener on `127.0.0.1` (`JETSTREAM_PORT`, default 41321) answers hook events, permission decisions and live board
edits, so whatever can reach it can drive your deck. It is authenticated by a shared secret:
32 random bytes written `0600` beside `projects.json` (`listener-token.ts`), generated by the
plugin on first run, sent by the hooks and the CLI in an **`x-jetstream-token`** header.
`/health` stays open — the installer polls it before a token can exist, and it discloses only the
version. Browser-borne requests are blocked separately by the Origin/Referer guard in server.ts.

**Honest scope — a bar-raiser, not a boundary.** It does not stop a process running AS you (it can
read the file too). It also does not survive **port squatting**: the port is fixed and unprivileged,
so another local user who binds it (`JETSTREAM_PORT`, default 41321) before Stream Deck starts is handed the token in
the hooks' own request headers and can replay it later. Closing that needs a transport that never
hands the secret to whoever answers — a `0700` unix socket, or challenge/response — which is the
shape any future hardening should take. What the token DOES stop is the easy case it was written
for: another local process merely connecting to an already-running listener and driving your board.

**Grace period.** Hooks installed by an older release send no token, and Claude Code keeps running
them until the user re-installs, so a MISSING header is still accepted while `ENFORCE_TOKEN` is
false — two releases — and `jetstream doctor` warns for that whole window. Once the listener holds
a secret, a WRONG token is rejected either way: no legitimate client sends one.

**No secret → the status feed survives, the sensitive endpoints do not.** If the token cannot be
written at all (read-only or MDM-managed home, a full disk), `classifyRequest` returns `no-secret`.
Under enforcement that keeps **`/hook`** served — it only colours keys, and refusing it is what
turns a token problem into a black board — while **`/permission` and `/slot` are refused**, since
answering permission prompts and planting keys are the whole reason for authenticating. Neither
extreme is right on its own: fail-open everywhere would let anyone who can *provoke* the no-secret
state (filling a shared disk before first start) switch authentication off; fail-closed everywhere
would black out a user whose home is merely read-only. The plugin re-attempts creation about once a
minute rather than resolving this once at boot, so a transient failure closes the window on its own
instead of leaving authentication degraded until Stream Deck restarts, and `ensureToken` **adopts**
a token found at any candidate path rather than minting a rival (two secrets is worse than none —
clients on the older one would be rejected as presenting a WRONG token). Doctor reports it loudly.

## How per-project status works (the hero mechanism)

Claude Code hooks fire during **every** session (interactive included) and can run a command. Install
Jetstream's hook globally in `~/.claude/settings.json` for `SessionStart` / `UserPromptSubmit` /
`Notification` / `Stop` / `SessionEnd` (etc.); each fires `jetstream-status-hook`, which POSTs the
payload (carrying `cwd` + `session_id`) to the plugin's **local HTTP server**. The `status` reducer
maps events → per-session status, `matchProject(cwd)` routes a session to its project key, and
`statusByProject` aggregates (needsInput > failed > working > done > idle) into the key colour. The hook is
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
`CLAUDE_CODE_OAUTH_TOKEN` for headless. The **5h/7d gauge** shows interactive usage. Nothing the
plugin ships spawns `claude` any more (the Launch key is gone; `chat` runs in the user's own
terminal), so no keypress can draw quota — but the env-stripping stays as the standing rule for
anything that ever spawns again.

## Architecture (monorepo)

- **`packages/usage`** — BUILT (12 tests). Reads Claude/Codex usage into a typed `UsageFeed`; ships a
  statusline hook that captures it to a cache the reader/resolver reads. Node built-ins only.
- **`packages/claude`** — BUILT (9 tests). Drives `claude -p`: pure `buildArgs`, `sanitizeEnv`
  (strips the API key), `parseStreamLine`, and `runClaude` (injectable spawn). Node built-ins only.
- **`packages/status`** — BUILT (9 tests). The hero core: `parseHookPayload`, `matchProject`,
  `reduce`, `statusByProject`, `needsAttention`, `colorFor`, + the silent lifecycle hook that POSTs
  to the plugin. Pure reducer + a thin hook. Node built-ins only.
- **`packages/jetstream`** — BUILT. The `@elgato/streamdeck` plugin: `<uuid>.sdPlugin` +
  `manifest.json`, one `SingletonAction` per key type (project / fleet / attention / usage /
  approve-deny / settings / nav / build / stop-all / coord / grid / the generic slot, plus the SD+
  fleet dial), the **local HTTP hook-listener server** feeding the `status` reducer, key rendering
  (colour + label + elapsed), the switch actions, the consolidated **`jetstream` CLI** (`init` — the
  guided wizard: projects.json + hooks + an optional prebuilt key layout; `chat` — the conversational
  setup: the model proposes, the code validates + writes, then offers the layout; `hooks install`
  writes the global hook + statusline hook into `~/.claude/settings.json`; `doctor` is a read-only
  health check; `setup` does hooks + a `projects.json` template), the bundled two-page Board/Ops
  profiles (profile.ts), and startup **`projects.json`** seeding of the board's fleet. Depends on the
  three cores via `workspace:*`.
  Distribution is **CLI-first**: the packed plugin (UUID `gg.pim.jetstream`) ships inside the
  `@pimmesz/jetstream` npm package and installs with `npm i -g @pimmesz/jetstream` → `jetstream
  install`. The Elgato Marketplace is a parked/later discovery channel, not the primary path.

Gate: each package has its own `typecheck`/`test`/`check`; the root `ci.yml` runs `pnpm check` +
`pnpm lint` + `npm pack --dry-run` across every package on each PR, and publishes to npm (OIDC
trusted publisher) on a push to `main`.

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
