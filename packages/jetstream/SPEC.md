# Jetstream — SPEC (v1)

**A physical command board for Claude Code across all your projects.** One Stream Deck key per
project; each glows with that project's live Claude status: grey (no session), slate (idle), **orange
(working)**, **amber (needs you)**, **green (done)**. Pressing it jumps you into that project.
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
repos without a placed key) plus an optional settings preset. The plugin also **auto-wires its hooks on first launch** (`autoWireHooks`: status, permission, the
`PreToolUse` stop gate, and the usage statusline when you have none; a config-dir marker records the
hook-set version, so manual removal sticks until an update adds a hook; same-script hook entries are
refreshed across node-runtime changes, never duplicated; non-fatal),
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
wins). Pressing a Project key now opens the project folder **in your editor** (switchto.ts: on
macOS VS Code, then Cursor, else Finder; elsewhere `code`, then `cursor`, then `$EDITOR`, else the OS
opener; no shell, no terminal, never launches `claude`),
replacing the planned jump-to-terminal UX. Remaining: on-device verification (a real deck + real
`~/.claude/settings.json`) and the Windows gaps (interrupt + process discovery are macOS/Linux-only;
the editor/folder open works everywhere).

## The board (v1 key set)

| Key                    | Face / colour                                                                                        | Press                                                                                             | Backed by                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Project** (one each) | name + live colour: grey none · slate idle · **orange working** (+ elapsed) · **amber needs you** (sub-line `approve on deck` when the deck holds the prompt, else `answer in Claude`) · **green done** (`done Xm · +120/-40`) · **magenta failed** (`✕`, `failed Xm`: the API killed the turn) | switch to it: open the project folder in an auto-detected editor (VS Code, then Cursor, else Finder) | `status` reducer ← hooks           |
| **Fleet** roll-up      | one always-visible key: `3w 1! 2✓` counts, coloured by the WORST state present (needsInput > failed > working > done) | lit board: ack blip · dark board: shows why (`add repos` / `wire hooks` / `all idle`)             | `status.summarize`/`worstStatus`   |
| **Attention** doorbell | dim; lights **amber** (needs input) or **magenta** (a died turn) and names the project              | jump to that project                                                                              | `status.needsAttention`            |
| **Usage** gauge        | 5h / 7d used %, sooner-of reset countdown; a `usage` slot with `provider: "codex"` shows Codex instead, its long window labelled by length (`7d`, or `30d` for a monthly one) | re-read now                                                                                        | `usage.resolveUsage` / `resolveCodexUsage` |

Projects are user-configured `{ id, name, path }` — whatever repos you run
Claude in; each Project key's settings panel takes a name + path.

**Deck approvals (v1.1):** you CAN approve/deny a permission prompt from the deck. Claude's
`PermissionRequest` hook is synchronous, so Jetstream's hook holds its response open until an
**Approve** or **Deny** key is pressed (or ~90s passes, after which Claude shows its normal dialog).
Place one Approve key + one Deny key; they act on the oldest pending request. You still can't answer
a free-text question or drive the TUI — for those, amber = "go to your keyboard," and the press gets
you there. **Stop (4.0):** long-press a working Project key to stop its current turn. The press writes a stop flag
that the `PreToolUse` stop gate consumes at the next tool call, so the turn ends and the session stays
open (an external SIGINT would end the whole session).

## The Ops page (post-item-G key set)

The bundled deck is two pages — **Board** (the keys above) and **Ops** (controls) — linked by a
**Nav** key (nav.ts) that flips the device between the bundled Board/Ops profiles (Standard + XL;
the Mini has no room for a second page).

| Key                    | Face / colour                                                                     | Press                                                                          | Backed by                     |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| **Stop all**           | `N working`, red while anything runs                                              | stop the current turn of every running Claude session (the panic key)          | `stopSessions(board.allActiveSessions())` |
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
32 random bytes written `0600` under the config dir (`listener-token.ts`), generated by the
plugin on first run. Current clients never send it. `/hook` carries no token (it only colours keys).
The permission hook (`/permission`) and chat's live edits (`/slot`) sign each request instead
(the v2 format). They first **`GET /challenge`**, which answers 64 hex the plugin issued (its issue
time, random hex and an HMAC tag under a per-listener secret, so issuing stores nothing and a flood
of GETs cannot push out a client's): single use (at most 1024 used ones remembered per 60 s, refused
rather than forgotten when full), valid for 60 seconds, sent with `cache-control: no-store`, open
like `/health` and behind the same Origin guard. The request then carries that **`x-jetstream-challenge`**, an **`x-jetstream-nonce`** of
`<send time in ms>.<32 random hex>` and an **`x-jetstream-mac`**: the HMAC-SHA256 under the token
of `v2`, the kind (`req` or `slot`, so a MAC made for one endpoint is refused on the other), the
challenge, the nonce and the exact body. The plugin checks the MAC before it claims the challenge,
so junk requests cannot use up real ones. It answers with its own MAC over the same challenge and
nonce: `res` over the decision for `/permission`, and `slot-res` over `<status>\n<body>` for every
`/slot` answer (applied, 400, 404, 409, 500). The hook prints nothing, and chat counts the edit as
unanswered, unless that MAC verifies; an unsigned 401 is believed, since a refusal changes nothing.
The nonce stays in both MACs because whoever answers `/challenge` picks the challenge: an answer
must verify only for the request that asked. The challenge GET and the signed POST each open their
own connection, so the request reaches whoever holds the port at that moment and never rides a
socket that answered the GET. A client never falls back to an unchallenged request, since a
squatter could refuse the challenge on purpose to collect one it can replay. So a current hook or
CLI against a plugin without `/challenge` (4.1.0 or older) gets no challenge: prompts fall back to
Claude's own dialog and chat (401) to its restart write until the plugin is updated.

**Older clients are still accepted.** The 4.1.0 signed format has no challenge: its MAC covers the
kind, the nonce and the body, and the plugin refuses one whose nonce is malformed, more than
2 minutes from its clock, or already seen. It remembers up to 1024 nonces with a matching MAC for
their 2-minute window, and refuses new ones when full rather than forget one. A 4.1.0 permission
answer carries the MAC of `res`, the nonce and the decision; a 4.1.0 `/slot` answer carries none.
The leading `v2` line keeps a v2 MAC from ever matching a 4.1.0 one, so keeping this path does not
weaken current clients. A hook or CLI older than signing still sends the token itself in an
**`x-jetstream-token`** header, which the plugin still accepts. Both older formats are to be
retired together in a later major release.
**The mint path is authoritative.** `XDG_CONFIG_HOME` is normally set in a shell profile and absent
from the desktop env, so every process derives its own candidate list — and readers take the FIRST
candidate holding a token. Writing the right value in one place is therefore not enough: a stale
token at an earlier candidate still wins for whoever can see it, and the two sides then reject each
other as presenting a WRONG token. So `ensureToken` resolves ONE authoritative token — the one at
`~/.config/jetstream/listener-token` (`%APPDATA%` on Windows, which desktop processes genuinely see)
— and then RECONCILES every other candidate to it. Convergence comes from all candidates holding the
same bytes, not from ordering. A token found only at an older path is adopted and copied there
rather than replaced. Only a well-formed token (64 hex chars) is ever adopted or propagated: a
truncated or hand-edited file is healed, never spread. Creates are atomic — a complete temp file
`link()`ed into place, `rename()` when replacing — so no reader observes a half-written secret, and
`jetstream doctor` warns if two locations ever do disagree.
`/health` stays open — the installer polls it before a token can exist, and it discloses only the
version. Browser-borne requests are blocked separately by the Origin/Referer guard in server.ts.

**Honest scope — a bar-raiser, not a boundary.** It does not stop a process running AS you (it can
read the file too). **Port squatting:** the port is fixed and unprivileged, so another local user
can bind it (`JETSTREAM_PORT`, default 41321) before Stream Deck starts. Current hooks and the CLI
never hand it the token, and it cannot forge a signed answer, so the permission hook prints nothing
and Claude asks in its own dialog, and chat never reports an edit applied on its word. A request it
captured carries a challenge the squatter made up, which the real plugin never issued, so it cannot
be replayed there. The squatter still reads what is sent to it (status events, permission prompts,
chat's key edits). Older clients keep the older gaps until they are updated: a 4.1.0-format request
a squatter captured can be replayed to the plugin once within its 2-minute window, a squatter can
tell a 4.1.0 CLI that an edit applied (its `/slot` answer is unsigned), and a hook or CLI older than
signing hands it the token. What the token DOES stop is the easy case it was written for: another
local process merely connecting to an already-running listener and driving your board.

**Enforcement is ON** (`ENFORCE_TOKEN = true`). The token shipped in 2.0.0 — 2.0.2 was the first
build that actually reached a deck — and the two-release grace period is long past. An untokened
request (no valid signature and no valid token header) is now refused on `/permission` and `/slot`;
`/hook` stays served, so a hook older than the
token still colours keys instead of blacking out the board, and re-installing hooks restores the
rest. A WRONG token was always rejected: no legitimate client sends one.

**Untokened → the status feed survives, the sensitive endpoints do not.** This covers both ways a
request can arrive without a valid token: a client older than the token (`legacy`), and this side
being unable to write one at all (`no-secret` — a read-only or MDM-managed home, a full disk).
Enforcement keeps **`/hook`** served for either — it only colours keys, and refusing it is what
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

**Hook spool** (status-hook.js, spool.ts in the status package): an event the plugin refused because
it was not listening (Stream Deck restarting for a chat structural edit, say) is appended to
`~/.jetstream/hook-spool.jsonl` and replayed once the plugin listens again, applied as of when it
fired. Only the fields the board reads are kept (event name, session id, cwd, notification type,
source, tool name, agent id, pid, fire time and the number of background tasks), never prompt text
or tool input. Events over an hour old are not replayed, and the spool starts over when the next
event would take it past 256 KB or its last append is over an hour old. The plugin writes to it too:
when Stream Deck closes it before the board restore has settled, it appends the live events its
restore gate was still holding (already answered 204), with the same fields, so the next instance
replays them in fire order.

**Pending chat edits** (chat-pending.ts): chat keeps unsaved live edits in
`~/.jetstream/chat-pending.json` (0600, keyed by profile and page), so a later chat still sees keys
an earlier one placed live but never saved. An edit stays while the chat that made it runs, and
otherwise until 1 h after it last went live. Chat sends such a key again rather than trusting it as
unchanged, and forgets it when the plugin answers 409 there.

## Verified capability matrix (re-verify at build — these change)

Sources: Claude Code headless/sessions/hooks/statusline docs; `@elgato/streamdeck` 3 (the plugin runs
on Stream Deck's bundled Node 24 runtime, Stream Deck app 7.1 or newer); the npm CLI needs Node 22.12 or
newer; `@elgato/cli` 1.8 (`streamdeck` CLI: create / link / restart / pack / validate).

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
