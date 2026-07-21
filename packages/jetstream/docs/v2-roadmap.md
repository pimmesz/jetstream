# Jetstream — v2 roadmap

_From a multi-agent discovery (5 research finders → Opus synthesis → Opus adversarial critic).
21 items survived; 10 rejected as infeasible/off-mission. Ranked by value × effort × feasibility,
each tagged with who should build it: **fable** (mechanical, gate-verifiable), **opus** (needs
design/architecture judgment), **hw** (needs a Stream Deck+ or manual device verification)._

## Strategic take

After v1.1/v1.2, Jetstream **already leads on the approval/attention surface** — its blocking
`PermissionRequest` approve/deny, colour-blind glyphs, and escalation flash beat claude-deck (which
breaks on permission dialogs) and match agentsd's core. It **trails on two axes**: overflow (agentsd
has a session cycler + N/M counter; Jetstream hard-caps at physical keys) and hardware (AgentDeck
drives an SD+ dial cockpit). AgentDeck is also a scope cautionary tale (16 surfaces, ~32k-LOC daemon)
— mine single features, not the architecture.

**The two differentiating bets:**

1. **Make the one proven interaction informed + sticky** — permission preview (#1) + Always-Allow
   (#2) + elicitation split (#7) turn a blind doorbell into a real triage-and-decide surface no
   competitor fully has.
2. ~~**Own the loop past "done"** — diff badge (#4) → CI/PR status (#8) → ship-as-`afterburner/`-PR
   (#12).~~ **Retired 2026-07-20.** The middle leg shipped and was then removed (see the status note
   below), and the `afterburner/` integration the last leg chained into came out in v1.5.0. The diff
   badge (#4) still stands on its own; #12 is unbuilt and would now need its own branch-naming design
   rather than inheriting one. Jetstream's differentiation rests on bet 1.

## Status note — 2026-07-20: built, then removed

_Three keys on this roadmap shipped and have since been taken back out of the plugin. They are kept
in the tables below for the record — do not read them as open work and do not re-propose them._

- **CI/PR status (#8)** — shipped as a `gh`-polling key (`actions/ci.ts`, `ci-status.ts`, config key
  `ciBranchPrefix`); removed. It was the only thing that made an external CLI Jetstream doesn't own a
  runtime dependency, for a signal GitHub already pushes elsewhere. `gh` is now a dependency of
  nothing.
- **Launch presets** — shipped as `actions/launch.ts` firing headless `claude -p`, plus the
  `launchModel` config key; removed. Consequence for the Opus tier: #11 (prompt recipes), #15
  (resume/fork) and #17 (fan-out) all assumed a launch primitive that no longer exists — each would
  have to rebuild it before it can be built.
- **Model toggle** — shipped as `actions/model.ts` (default/opus/sonnet/haiku) and its own slot kind;
  removed alongside Launch, the only key it fed.
- Earlier, v1.5.0 removed the **afterburner** integration and the **heartbeat** and **review** keys.

Still shipping: Project status · Fleet roll-up · Attention doorbell · Usage gauge · Approve/Deny ·
Jetstream settings · Build version · Stop all · page Nav · Coordinate · Grid · Fleet dial · the
generic Slot key. The CLI is `install`, `setup`, `init`, `chat`, `hooks install`, `doctor`, `update`
— with **`jetstream chat`**, the conversational board builder, as the headline surface.

## Next Fable batch (v1.3) — SHIPPED

_All six landed in v1.3 (commit `22f791d`, items A–F), except **#1**, which pre-dated v1.3 — it was in
the original plugin; v1.3 item E only improved its legibility — and **#18**, a deliberate partial (only
Launch is marked; approve/deny and Settings are intentionally off). The remaining v1.3 piece, **item G**
(onboarding CLI + config-file projects + doctor), is now built too.
The fable tier is exhausted; the genuinely-remaining work is all Opus-tier below._

| #   | Item                                          | What                                                                                                                                             |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Permission preview** `fable/S`              | **(shipped pre-v1.3)** Render the pending tool + input (`Bash: rm -rf dist`) on the held key before APPROVE/DENY — `summarizeTool`/`PendingPermission.summary` were in the original plugin; v1.3 item E only made it more legible. |
| 3   | **Reset countdown** `fable/S`                 | `resets in 3h 33m` next to the 5h/7d gauge. Drives wait-vs-burn better than the % alone.                                                         |
| 4   | **Diff-magnitude badge** `fable/S`            | On Stop, `git diff --numstat` in the cwd → badge the green key `+120/-40` so review attention routes to the big changes.                         |
| 6   | **Fleet roll-up key** `fable/S`               | One always-visible key: `3 working / 1 waiting / 2 done`, colour = worst state, flash on new needs-input — nothing off-page is lost.             |
| 7   | **Elicitation-vs-permission split** `fable/S` | Distinguish a tappable permission prompt from an observe-only open question, so you never waste a tap on a prompt the deck can't resolve.        |
| 18  | **Multi-action flag** `fable/S`               | Mark Launch/Interrupt/Settings `SupportedInMultiActions` so users chain them into their own macros. Cheap enabler.                               |

## Opus tier — real design/architecture work

| #   | Item                                                | What                                                                                                                                                                                  |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | **Always-Allow** `opus/M`                           | Third key: approve + record a **session-scoped** allow rule so repeat-safe prompts auto-answer. A deliberate, bounded relaxation of "every grant is a keypress" — needs scope design. |
| 5   | **Ack/snooze/re-escalate** `opus/M`                 | PagerDuty semantics for the doorbell: tap=ack, auto re-flash if still blocked, snooze. The keystone the other attention wins build on.                                                |
| 8   | **CI/PR status key** `opus/M`                       | **(built, then removed 2026-07-20 — see status note)** Poll `gh` for the opened PR's checks → spinner/green/red + flash on failure. Closes "done" → "actually green".                             |
| 9   | **Attention profile auto-switch** `opus/M`          | On a permission request, `switchToProfile` flips the deck to a big APPROVE/DENY/context page, auto-revert after. Opt-in.                                                              |
| 11  | **Prompt recipe library** `opus/M`                  | Per-key saved headless launches (prompt+model+tools+mode) — "write tests", "triage CI" — one press each.                                                                              |
| 12  | **Ship-as-PR** `opus/M`                             | Long-press a done key → commit & push the worktree as an `afterburner/` PR (never a protected branch). Completes status→approve→**ship**.                                             |
| 13  | **DND / quiet-hours + per-project snooze** `opus/S` | Gate escalation on quiet hours + a "DND 1h" key; mute one noisy project while colours stay live.                                                                                      |
| 14  | **Rolling per-session/day cost** `opus/M`           | Sum transcript usage via `ModelCostTable` (never a hardcoded rate) → per-key burn + a day total, labelled an estimate.                                                                |
| 15  | **Resume/fork a prior session** `opus/M`            | One key launches `claude -p --resume <id>` for a chosen past session (ids from `~/.claude`).                                                                                          |
| 16  | **Presence-gated escalation** `opus/M`              | Poll host idle time so the loud flash only fires once you've actually left.                                                                                                           |
| 17  | **Fan-out launch + pick-a-winner** `opus/L`         | One key fires the same prompt across N worktrees (or Opus-vs-Sonnet); a PICK key merges the winner, discards the rest. Spend-guarded. The biggest, most deck-native bet.              |

## Hardware-gated (Stream Deck+ only — moot on your XL)

| #   | Item                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10  | **Tap-to-focus terminal** `hw/M` — raise the project's terminal window (AppleScript; not TUI injection, so allowed). Feasible on any deck but fragile cwd→window mapping, macOS-first → manual verify. |
| 19  | **SD+ usage/spend cockpit** — touch-strip burn gauge + dial to cycle metric.                                                                                                                           |
| 20  | **SD+ session scrub + last-action ticker** — dial scrubs all sessions (beats the key cap), touch strip shows the highlighted one.                                                                      |
| 21  | **Audible attention cue** `hw/S` — sound on needs-input (no SDK audio API → OS playback in the server; per-OS verify).                                                                                 |

## Rejected (don't build)

- **Voice/dictate, quick-actions (GO ON), answering elicitations, Happy/Crystal/VibeTunnel sync** —
  all require driving/wrapping a **running interactive TUI**, which the hook-observe design forbids.
- **Multi-provider usage** (Codex/Gemini/…) — reuses each CLI's stored creds, against Jetstream's
  subscription-only, strips-key ethos. (Adopt the reset-countdown formatting only — that's #3.)
- **AgentDeck's full 16-surface architecture** — a scope trap; mine single features.
- **Deep-link hook transport, SD+ launch dialer, burn-rate sparkline, open-usage-page link** — cut
  by the critic as lower value than their in-tier alternatives.
