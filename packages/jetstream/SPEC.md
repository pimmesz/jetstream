# Jetstream — SPEC (v1)

**A physical command board for Claude Code across all your projects.** One Stream Deck key per
project; each glows with that project's live Claude status — grey (no session), blue (idle), **red
(working)**, **amber (needs you)**, **green (done)** — and pressing it jumps you into that project.
Plus a "needs you" doorbell and a usage gauge. It reads status from Claude Code lifecycle hooks, so
it works for the interactive sessions you actually run all day, not just headless launches.

Standalone — no afterburner required; afterburner is just one of the projects on the board.

Status: **BUILT.** The three cores (`usage`, `claude`, `status`) are unit-tested, and the Elgato
plugin bundles, passes `streamdeck validate`, and packs to `gg.pim.jetstream.streamDeckPlugin`.
Remaining: on-device verification (install on a real Stream Deck), the hooks install on a real
`~/.claude/settings.json`, the macOS jump-to-terminal UX, and the Windows path — see Open items.

## The board (v1 key set)

| Key                    | Face / colour                                                                                        | Press                                                                                             | Backed by                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Project** (one each) | name + live colour: grey none · blue idle · **red working** (+ elapsed) · **amber needs you** · **green done** | switch to it — focus the project's Claude terminal (macOS), else open a terminal at the path running `claude --continue` | `status` reducer ← hooks           |
| **Attention** doorbell | dim; lights **amber** and names the project when ANY project needs input                              | jump to that project                                                                              | `status.needsAttention`            |
| **Usage** gauge        | 5h / 7d used %, reset countdown, model                                                                | (optional) open `/usage`                                                                           | `usage.resolveUsage`               |
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

## How per-project status works (the hero mechanism)

Claude Code hooks fire during **every** session (interactive included) and can run a command. Install
Jetstream's hook globally in `~/.claude/settings.json` for `SessionStart` / `UserPromptSubmit` /
`Notification` / `Stop` / `SessionEnd` (etc.); each fires `jetstream-status-hook`, which POSTs the
payload (carrying `cwd` + `session_id`) to the plugin's **local HTTP server**. The `status` reducer
maps events → per-session status, `matchProject(cwd)` routes a session to its project key, and
`statusByProject` aggregates (needsInput > working > done > idle) into the key colour. The hook is
**silent** (prints nothing — some hooks treat stdout as injected context) and always exits 0, so it
can never disturb a session.

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
- **`packages/jetstream`** — TODO (PHASE 2). The `@elgato/streamdeck` plugin: `<uuid>.sdPlugin` +
  `manifest.json`, one `SingletonAction` per key type (project / attention / usage / launch), the
  **local HTTP hook-listener server** feeding the `status` reducer, key rendering (colour + label +
  elapsed), the switch/launch actions, and `jetstream hooks install` (writes the global hook +
  statusline hook into `~/.claude/settings.json`). Depends on the three cores via `workspace:*`.
  Ships via the **Elgato Marketplace** (UUID e.g. `gg.pim.jetstream`), not npm.

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
- Switching/focus on macOS (AppleScript to focus a terminal) vs the reliable fallback (open a new
  terminal `--continue`); Windows equivalent.
- The statusline usage payload field names (`rate_limits.five_hour.used_percentage` / `resets_at`).
- npm scope (`@pimmesz/*` placeholder) + the Elgato plugin UUID + a local server port default
  (`JETSTREAM_PORT`, currently 41321).
