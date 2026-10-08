# Decisions

Durable record of design calls that would otherwise be re-litigated every audit.
Newest first. A decision here is settled — re-open it only against its stated trigger.

---

## 2026-10-08: review fixes

A review of the 2026-10-06 work (the three sections below) found 49 items, from a
restore bug that erased a checkpointed status to style nits. The maintainer asked for all of them
to be fixed. Where a line below now says otherwise, this section supersedes it.

**Restart and the hook spool** (race F1):

- The spool keeps only the fields the plugin reads back (`hook_event_name`, `session_id`, `cwd`,
  `notification_type`, `source`, `tool_name`, `agent_id`, `_pid`, `_at`, and `background_tasks` as
  zeros of the same length), so no prompt text, message or tool input waits on disk; the live POST
  is unchanged. When the next line would pass 256 KB, or the last append is over an hour old, the
  spool starts over instead of refusing new lines. A single line over 256 KB is still dropped.
- A replayed event is applied as of when it fired (`min(_at, now)`), not when it was replayed, so
  elapsed time, the stall glyph, doorbell order and the inflight TTL count from the fire time, and
  an event 10 to 60 minutes old keeps its `firedAt`. The replay filter (stale skip, a stale
  SessionEnd included, and the subagent exemption) is `replaySpool` in plugin-wiring.ts, with
  tests. A payload that throws is logged as `spool replay` and the rest of the batch still runs; a
  throwing drain can no longer stop the 5 s poll, and `takeSpool` never throws.
- Spool drains, at bind and on the poll, wait until `board.restore()` has settled. During the
  restore only an event that changes a session, or a SessionEnd, keeps that session's checkpoint
  entry from being restored, so an idle nudge no longer erases a checkpointed `done`. `restore()`
  keeps the checkpointed `firedAt` (the fire-order guard and the stale skip now hold across a
  restart) and writes the checkpoint again after merging.
- The checkpoint is flushed on process `exit`, so it is also written when Stream Deck closes the
  socket and the plugin exits without a signal. SIGTERM and SIGINT now only exit.
- status-hook.js's producer contract (`_pid` and `_at` stamped, no token, spool only on a refused
  connection) is `runStatusHook` in status-hook.ts, with tests.

**Loopback auth** (amends 2026-07-25 #3 and the dos-resource-2 line below):

- `/slot` is signed like `/permission`: `jetstream chat` sends a nonce and
  HMAC-SHA256(token, "slot\n" + nonce + "\n" + body), never the token, so no current hook or CLI
  hands the token to a port squatter. The `slot` kind keeps a `/permission` MAC from being accepted on
  `/slot`.
- A signed nonce is `<send time in ms>.<32 random hex>`, inside the MAC. The plugin refuses a
  signed request whose nonce is malformed, more than 2 minutes from its clock, or already seen. It
  remembers only nonces whose MAC matched, for their 2-minute window, up to 1024, and refuses new
  ones when full rather than forget one. The signed format was never released, so an unstamped
  signed request gets no compatibility path.
- The plugin still accepts the `x-jetstream-token` header on `/permission` and `/slot` from a hook
  or CLI older than signing, so a mixed install keeps working.
- The listener sweeps its timeouts every second (`connectionsCheckingInterval: 1_000`): headers
  time out at 10 to 11 s and bodies at 30 to 31 s, where they were 10 to 40 s and 30 to 60 s. A
  connection dropped over the 128-socket cap is logged, the first one and then at most one a minute.
- SPEC.md and the listener-token.ts JSDoc describe this; they no longer say the hooks send the
  token or call challenge/response future work.

**Chat live edits:**

- Chat keeps a pending live edit only while disk still shows the key as it was before chat's edits
  there, and forgets it as soon as disk shows anything else (chat's own edit, a change on the deck
  or by another chat, a native key, no key), so the next plan sees what disk now shows there
  instead of chat's old edit. A change disk does not show yet, or one made after chat's last
  re-read, is still unseen (see the restart-fallback residual). This replaces "keeps every pending
  one until disk shows it".
- A 409 reads "that key changed since the plan was made", followed once by "Stream Deck may not have
  saved a recent edit yet (from another chat or on the deck itself), or another page is on screen."
  and "Safest: wait a few seconds, decline the restart, then send the request again."
- Tests pin the rollback's compare (`expect: ours`; a 409 is not reported as unrestored) and the
  stored-form normalization.

**Slot keys** (amends authz-authn-3 of 2026-10-06):

- The `allowRunKeys` gate for an `app` slot is decided on disk at press time (`isRunTarget` in
  slot-command.ts). A regular file with any execute bit (an extensionless `chmod +x` script, the
  binary inside an app bundle), the launcher types `.py`, `.jar`, `.fileloc`, `.inetloc` and
  `.webloc`, a Finder alias (whatever it points at, since Node cannot resolve one), and a symlink
  whose resolved target has a run-like name now also show "run off" until it is on. A folder opens
  ungated whatever its name (`three.js`), except an Automator `.workflow`, and so does an `.app`
  bundle; a target not on disk is judged by its name. The accepted trade widens with it: a migrated native Open key to an executable file now
  needs `allowRunKeys`.
- The `/slot` compare-and-write reads the plugin's own record of what each slot key holds (seeded on
  appear, updated after each write and on inspector edits), not the SDK settings cache, which a
  late `getSettings` answer could refill with pre-write values. "Two writers cannot both pass the
  compare" now also holds against that.
- One slot whose settings read times out no longer stops the usage refresh, and a usage press
  always ends in a check or an alert.
- The shared Doorbell snooze and the attention slot routing have tests; the dead rejection handler
  and the test-only re-exports are gone.

**Usage** (amends the Codex usage gauge decision below):

- The Codex reader skips a `rate_limits` snapshot whose `limit_id` is anything but `codex`: a
  per-model bucket (`codex_bengalfox` for GPT-5.3-Codex-Spark) reads 0% and was replacing the
  account's limits. A snapshot without a `limit_id` (older logs) still counts as the account.
- The long window is labelled by its logged length, `round(minutes / 1440)` days: `7d` for the
  weekly window, `30d` for a free plan's 43200-minute one. Claude stays `7d`, the statusline line
  follows the same rule, and a passed reset keeps the length (`30d 0%`).
- The standalone Usage key re-reads on press like the usage slot, and shows an alert when it still
  finds no usage.
- The snapshot prune also deletes leftover `<id>.json.prune-<hex>` copies older than eight days; a
  recent one stays until it ages out. The move-aside, link-back and EEXIST paths have tests.

**Fleet and npm** (amends #7, #9 and #10 below):

- `replayFleetDelta` tracks entries by id, the identity the editor removes by. A removal drops the
  disk entry with the same id and canonical path, so removing one of two spellings of a repo
  (`repo` and `repo/`, or a symlink) works, and an id another writer has since given a different
  repo is left alone. The in-app add and chat's merge compare canonical paths: a second spelling of
  a fleet repo is a duplicate, and chat keeps the existing id. Chat's merge keeps both entries when
  the file already lists a repo twice, since it never infers a removal.
- The in-app editor waits about 100 ms for the fleet lock, not 3 s, because the wait blocks the
  plugin's only thread (keys, `/hook`, `/permission`); it then shows "another Jetstream writer is
  holding ...; try again". `jetstream chat` and `init` still wait up to 3 s.
- `jetstream update` prints a note when npm's global copy (by realpath) is not the `jetstream` that
  ran: "npm installs into <dir>, but this `jetstream` runs from <root>; remove that copy or put
  npm's global bin first on PATH." #9's reopen trigger is answered with a warning, not a fix.
- The npmjs.org default also goes on npm's argv as
  `--@pimmesz:registry=https://registry.npmjs.org/`, because zsh and dash drop the environment name
  `npm_config_@pimmesz:registry` when npm is a script shim. A `JETSTREAM_REGISTRY` mirror stays
  environment-only, since a token can sit in its path where no check can see it. Argv therefore
  only ever carries the constant, and SAFE_REGISTRY stays defence in depth for the Windows
  `npm.cmd` fallback.
- The post-install health check waits for the version it was told to expect, with a test. The
  plugin CLI answers `install` with the npm install steps, as it does `update`, so its help line is
  true.

**Docs and style:**

- The action registry Record lives in action-registry.ts, and its test checks each instance's
  `manifestId` against its key, so a mis-paired registration fails (amends #6 below).
- README says the plugin writes `~/.claude/settings.json`, and that a `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` set only in a shell profile is not seen by the plugin (it runs under the Stream Deck
  app), with the shell step for each. The project inspector, SPEC and README give the macOS editor
  order (VS Code, then Cursor, else Finder; `$EDITOR` is read only off macOS). The settings
  inspector points at its own "Enable per-tool detail" button, not a CLI a Marketplace install
  lacks.
- plugin-catalog.ts uses the shared `stripControl`, so "one `stripControl`" below is now true.
  The installHooks JSDoc is back on its function, and comments narrating history, booleans not
  named as questions, and em dashes on touched lines were fixed.

**Claude x Codex cross-review of these fixes (gpt-6.1-sol, then a gpt-6-astra pass):**

- Live `/hook` events that arrive while the board restores are held (`createHookGate` in
  plugin-wiring.ts, at most 1024 and 8 MiB) and applied after the spool replay, each as of when it
  arrived.
  Replaying after the live events had broken subagent pairs: a live SubagentStop landed before its
  spooled Start (the agent stayed "working"), and a spooled SubagentStop with no background tasks
  cleared an agent that had started live. Board's own `touchedSessions` guard stays as is.
- An empty `background_tasks` list (on Stop or SubagentStop) clears only the agents that started
  before the event fired, so a SubagentStop that a later 5 s poll replays (refused just before the
  bind, appended after the startup drain) cannot clear an agent that started live meanwhile. Start
  and list are compared by the hooks' fire stamps when both carry one, since a live Start is applied
  when its POST arrives, which can be late; an older hook without stamps falls back to arrival time.
- The Codex reader compares the newest 8 files that hold an account reading, reading at most 64,
  so eight newer auto-review sessions with only model buckets no longer blank the gauge.
- A chat rollback sends a never-configured slot (`{}`) back as empty instead of being refused 400.
  Any other original is sent as it was, so one the plugin cannot parse (a migrated Website key with
  a URL `/slot` refuses) is refused and reported, never cleared. When an undo was not confirmed
  (refused, or no answer), chat says those keys "may still hold the new settings": after the live
  attempt, on a declined restart, and when the restart write fails, instead of "Nothing changed."
  or "Your board was not changed." A styled spacer (an empty key with a colour, label or icon) goes
  back as a plain empty key, because `/slot` never stores cosmetics on an empty key, and chat names
  it as having lost them.
- A usage slot press answers from its own read, even when a timer refresh superseded it.
- A project path that would run something (an executable file, a script, a Finder alias, an
  Automator `.workflow`) is not opened until `allowRunKeys` is on, like an `app` slot: the project
  slot shows "run off", and the standalone Project key, the Fleet dial and the doorbell jump show an
  alert (`openProjectFromKey` in switchto.ts). App slots and project paths share one rule,
  `isRunTarget`: a folder always opens, even one named like a script (`three.js`, `dotfiles.sh`),
  and the check uses the resolved path, so a symlink to a `.workflow`, or `x.workflow/.`, is gated.

**Residuals accepted:**

- Pending live edits live inside one `jetstream chat` process. A new chat (after the 20-turn limit,
  say) starts from disk alone, so its first live edit to a key Stream Deck has not saved yet gets a
  false 409. The advice above is printed, and declining the restart is safe. Persisting pending
  edits across processes was not built.
- If another writer puts back exactly a value a key held before chat's edit, before Stream Deck
  saves chat's edit, chat cannot tell the two apart and the next live edit at that key gets the
  same false 409.
- After a failed live apply, the restart fallback still writes by coordinate without comparing
  against disk.
- A hook or CLI older than signing still sends the token header, so it hands the token to a port
  squatter until it is updated. A newer hook or CLI against a plugin older than signing gets 401:
  permission prompts fall back to Claude's own dialog, and chat to its restart write with a "token
  mismatch" message. Updating the plugin fixes it.
- A signed request a squatter captured, which the real plugin therefore never saw, can be replayed
  to the plugin once within its 2-minute window; closing that needs a challenge the plugin issues
  first (an extra round trip). A `/slot` answer carries no MAC, so a squatter can tell chat an edit
  applied when it did not. It can neither approve anything nor learn the token.
- A hook event dropped over the 128-socket cap is logged but not spooled: the hook spools only a
  refused connection.
- `jetstream chat` and `init` wait for the fleet lock synchronously, up to 3 s, which only blocks
  the CLI. In the plugin the ~100 ms wait still blocks its thread that long, and within 10 s of a
  writer crashing while holding the lock an in-app add or remove fails fast until the lock is
  taken over.
- Two hooks deciding to start the spool over at the same moment: the second unlink can remove the
  line the first just wrote to the fresh spool. Same class as the claim and overshoot races below.
- `isRunTarget` checks the target at press time and the `open` follows, so a file swapped in
  between is not caught. The malicious `.app` bundle gap (authz-2) stays deferred.
- The empty-list cutoff compares wall-clock stamps, so a backward clock step between an agent's
  Start and the parent's empty list, together with that agent's own SubagentStop being lost, keeps
  the agent "working" until its 30 min TTL.
- `jetstream update` warns about another `jetstream` first on PATH but does not reorder PATH or
  remove that copy.
- A `JETSTREAM_REGISTRY` mirror reached through a zsh or dash npm shim loses the scoped pin, so a
  `@pimmesz:registry` line in .npmrc can still win for it.
- A `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set only in a shell is documented, not handled: auto-wire
  (also its re-wire after an update) and the inspector's "Enable per-tool detail" button still
  write `~/.claude/settings.json`, and the Codex gauge reads `~/.codex/sessions`. Doctor, run
  from that shell, does find hooks missing under its `CLAUDE_CONFIG_DIR`; it says nothing about
  Codex.

**TRIGGER to reopen:** a false 409 outside the cases above, Codex renaming its account bucket away
from `codex`, or the listener ever binding beyond loopback.

## 2026-10-06 (night): accepted and open items fixed on request

The maintainer asked for every remaining recorded item to be fixed. Each record named below is
superseded by the fix described here; the older text stays as history.

- **Race F1** (a session stuck "working" after a chat restart, accepted earlier today): status-hook.js
  now spools an event the plugin refused (`~/.jetstream/hook-spool.jsonl`, 256 KB cap, events over an
  hour old dropped) and the plugin replays it once it is listening again. Only a refused connection
  is spooled; a timeout may already have been delivered.
- **Page switch during a live chat apply** (accepted earlier today): every live `/slot` write carries
  `expect`, the settings the plan saw at that key, and the plugin answers 409 without changing anything
  when the key holds something else. A 409 is never rolled back. After a live apply chat lays its own
  keys over the re-read board, so Stream Deck saving late to disk cannot cause a false 409.
- **Usage snapshot prune race** (accepted residual earlier today): a stale snapshot is moved aside and
  re-checked before it is deleted; one rewritten in between goes back through a link, which never
  overwrites an even newer snapshot.
- **#7 projects.json lost update**: `writeFleetFile` takes the writer's `base` snapshot and replays only
  that writer's change (adds, removes, changed settings) onto the file as it is right before the
  rename (`replayFleetDelta`). Removal still works, which is what made the earlier merge-on-write wrong.
  The in-app editor and chat pass their base; `jetstream init` stays a whole-file replace because it
  only writes after an explicit "overwrite it? y".
- **#9 `jetstream update` targets**: the version check and the plugin handed to Stream Deck come from
  npm's own global root (`npm root -g`), not from the running copy.
- **#10 registry credentials**: the registry now reaches npm through its environment
  (`npm_config_registry`, `npm_config_@pimmesz:registry`), never its argv. Inline mirror credentials
  still work, but no longer show in `ps` for other users. Environment config outranks both `.npmrc`
  lines (verified against npm 11), so the pin still holds.
- **concurrency `shared-mutable-state-3`** (unverified): each icon extraction has its own temp file,
  removed afterwards.

A Claude x Codex review of these fixes found fourteen further edges, all fixed the same night: the
fleet writer holds a short exclusive lock (`projects.json.lock`, waits up to 3 s) from the re-read to
the rename, gives a concurrently added repo a fresh id, and the editor seeds and replies with the
fleet as saved; the plugin drains the hook spool on every 5 s poll as well as at bind, replays it in
fire order, and the spool's cap counts the event being added; `/slot` compare-and-write steps are
queued per key so two writers cannot both pass the compare; chat compares and remembers live edits
in the form the plugin stores (an empty slot drops its cosmetics), keeps every pending one until disk
shows it, and only for the same profile and page; a fresh usage snapshot whose link back fails is
renamed back, not deleted; the registry environment drops inherited upper-case spellings first; the
post-install health check expects the version npm installed; a rejected registry containing `@` is
never printed.

**Residuals accepted (cannot be closed from inside the plugin or without an OS lock):**

- Two pages holding byte-identical keys at the same position: a live edit cannot tell which page is
  on screen, because the Stream Deck SDK gives an action no page identity. Chat's own page check
  (Pages.Current on disk) still applies.
- A fleet lock left by a writer that crashed is taken over after 10 s; two writers reclaiming the same
  crashed lock in the same instant can still both write. A crash during a millisecond write is rare,
  and the `.bak` trail keeps every replaced fleet.
- The hook spool: an append that opened the file just as the plugin claimed it can land in the claimed
  copy and be lost (as every refused event was before the spool), and two simultaneous appends can
  overshoot the 256 KB cap slightly.
- Chat forgets its pending live edits when you switch page mid-chat; going back to the first page
  before Stream Deck saved them can give a false 409, which falls back to the restart write.
- A repo whose path another writer changed while this one edited it by the old path comes back as a
  new entry; nothing in the app or chat renames a repo's path.

Three regressions the same review found were fixed rather than accepted: chat remembered unchanged
native keys as empty slots (now only changed live slots are remembered), a remembered live edit hid a
later restart write at the same key (now forgotten), and a spooled event older than the session's
newest could be replayed over it (now skipped, a stale SessionEnd included).

## 2026-10-06 (later): built on request, superseding three deferrals above

The maintainer asked for everything still unbuilt. Recorded here so the deferrals and the v2
roadmap's rejection below are not read as still open.

### Codex usage gauge (reverses the v2-roadmap "multi-provider usage" rejection)

The rejection was about reusing each CLI's stored credentials. Codex writes its own rate limits
into every session log (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, `token_count` events,
`rate_limits.primary` / `secondary` with `used_percent`, `window_minutes`, `resets_at`), so reading
the newest log's tail needs no login and no network. **Decided:** a `usage` slot kind with
`provider: "codex"` (chat type `codex-usage`), its own key rather than a second line on the Claude
gauge, which is too small for both. A window of a day or less is the short one. A window whose reset
time has passed reads as 0% for both providers.

**TRIGGER to reopen:** Codex stops logging `rate_limits`, or moves its session logs.

### Deferred items now built

- **concurrency `file-write-races:file-write-races-1`** (the `usage.json` single writer): each Claude
  session writes `~/.jetstream/usage/<session>.json`, the reader merges them per window (a later reset
  wins, then the higher reading), snapshots older than eight days are pruned. The legacy file is
  still read. **Accepted residual:** a prune can delete a snapshot its session rewrote in the microseconds
  between the prune's stat and unlink; the next statusline render rewrites it, so no lock.
- **concurrency `ordering:ordering-1`**: status-hook.js stamps `_at` (fire time); the reducer drops a
  status event that fired before the one it already applied. A stamp more than ten minutes from
  arrival is ignored (untrusted `/hook`), and older hooks without one keep arrival order.
- **security `dos-resource:dos-resource-2`**: the loopback server caps sockets at 128, headers at 10 s
  and request bodies at 30 s. Receiving only, so a held `/permission` answer is unaffected.

### Folded into slots, and the refactor harness items

- The Usage and Attention keys are slot kinds (`usage`, `attention`), so chat moves them live; the
  standalone actions still work and migrate on a restart write. Both doorbell keys share one
  `Doorbell` (doorbell.ts), so a snooze on either quiets both; its face is the pure `doorbellFace`.
- **#6 (action registration)** is built: `action-uuids.ts` is the list, plugin.ts registers through a
  `Record` keyed by it (a missing registration does not compile), and the test checks the list
  against the manifest and the decorators.
- plugin.ts's token retry, bind retry, repaint coalescing and hook handler live in
  `plugin-wiring.ts` with tests; SettingsKey's inspector router is `routeInspectorMessage`.
- One atomic writer (`atomic-write.ts`), one `stripControl`, one `DANGER_RED`, one `errorMessage`.

- `jetstream chat`'s profile-write lock is never taken over automatically. A lock older than two
  minutes is reported with its path to delete: every takeover without an OS lock can admit two
  writers when several chats race for it, and a crash mid-write is rare.

Race F1 (stuck "working" after a chat restart) stays accepted as recorded below.

## 2026-10-06: needs-decision items from the post-4.0.0 audits

From security-audit, docs-drift-audit (package run), concurrency-audit and a targeted race review,
all 2026-10-06 (reports in the audit ledger). The maintainer delegated these calls.

### Do now (landed with the audit fixes)

- **security `authz-authn:authz-authn-2`**, `packages/status/src/hook.ts`: status-hook.js sent the
  shared token on every `/hook` POST although `/hook` is served without one (decision #2 above), so
  a port squatter collected it from any Claude event. The hook now sends no token, and the plugin's
  "untokened request" warning only fires for `/permission` and `/slot`.
- **security `authz-authn:authz-authn-3`**, `packages/jetstream/src/slot-exec.ts`: an `app` slot
  opened any path, so a `.command` or `.sh` target ran a script without the `allowRunKeys` opt-in.
  Script-like targets and any URL-form target (`isScriptTarget` in slot-command.ts; the opener decodes
  `file://%2E…`, so a suffix check alone is bypassable) now count as run keys and are gated by
  `allowRunKeys`; apps, files and folders still open as before. Accepted trade: a native Open key to a
  script that chat migrates into a slot now needs `allowRunKeys`, and says so on the key ("run off").
- **docs `api-signatures:api-signatures-2`**, `docs/slot-kinds-scoping.md`: marked as a superseded
  build record rather than kept in sync, like the item-g doc.
- **docs `install-setup:install-setup-2`**, `SPEC.md` capability matrix: updated to SDK 3, the Node 24
  plugin runtime and the CLI's Node >= 22.12.

### Accepted

- **race F1**, `packages/jetstream/src/state.ts` restore: a Stop hook lost while Stream Deck restarts
  (a chat structural edit) leaves a session restored as `working`. **Accepted:** the key shows the
  stall glyph after 20 minutes and the session's next hook event corrects it. Restoring an idle-CPU
  session as `done` was rejected: the CPU signal is a decaying average and a turn waiting on a long
  tool or the API reads idle, so it would show a false "done" while work continues, which is worse.
  **TRIGGER to reopen:** a user reports a key stuck on working after a chat edit.

### Deferred

- **security `dos-resource:dos-resource-2`**, `packages/jetstream/src/server.ts`: no connection cap or
  tightened header timeout. Unverified, and a cap sized wrong would starve held `/permission`
  requests. **TRIGGER:** a reproduced plugin stall from held sockets, or the listener ever binding
  beyond loopback.
- **concurrency `ordering:ordering-1`**, `packages/status/src/index.ts` reduce(): hook events are
  applied in arrival order, so a late PostToolUse can overwrite a later needs-you Notification. Only
  reachable with `--tool-detail` (the default install does not wire PostToolUse), and the fix stamps a
  fire time into the hook payload and changes the reducer's ordering rule. **TRIGGER:** tool detail
  becomes the default, or a report of a needs-you key showing working.
- **concurrency `file-write-races:file-write-races-1`**, `packages/usage/src/index.ts`: concurrent
  statusline renders write `usage.json` last-renamer-wins. Used % only rises within a window and the
  next render corrects it. **TRIGGER:** a Codex usage source is built (design a per-source, per-session
  cache then) or a reported gauge regression.

### No longer present

- **docs `api-signatures:api-signatures-1`** (SPEC.md:79 SIGINT / `board.allPids()`): fixed with the
  audit fixes.

## 2026-10-05: Claude Code 2.1.289 contract round

Jetstream's hook assumptions were last checked against Claude Code 2.1.216. This round re-checked
them against the 2.1.289 hooks reference and changelog.

### Deck stop keys stop the TURN through a hook, never with SIGINT (supersedes the 2-second cooldown)

An external SIGINT now runs Claude Code's graceful shutdown (changelog 2.1.132), and a single
SIGINT ended a test session within 4 seconds on 2.1.281. The project long-press, the dial, the
stop-all key and the slot `stopall` kind were ending sessions while claiming to interrupt them.

**Decided:** a press writes `~/.config/jetstream/stop/<session-id>`. A `stop-gate.js` hook on
`PreToolUse`, installed by default, consumes the flag and prints `{"continue": false}`, which ends
the turn and keeps the session (verified against a real headless run). A session the deck holds at
a permission prompt is answered deny with `interrupt: true` at once. `Stop`, `StopFailure` and
`SessionEnd` delete a leftover flag, and a flag older than 10 minutes is ignored, so a stop can
never cut the next turn short. The flag path ignores XDG and `CLAUDE_CONFIG_DIR` on purpose: the
plugin (GUI environment) and the hook (shell environment) must agree on it.

**Accepted trade:** a turn that is only generating text stops at its next tool call or ends on its
own; there is no mid-sentence stop. The gate costs one node start-up per tool call, with no network.

**Rejected:** sending Esc to the terminal (needs Accessibility permission and can hit the wrong
window), and relabelling the keys "end session" (removes the feature).

**TRIGGER to reopen:** Claude Code ships a supported external "interrupt this turn" signal or CLI.

### Chat writes structural edits into the board in place, never as an import

Every structural chat edit used to write `~/Downloads/Jetstream-Custom.streamDeckProfile` and open it,
and Stream Deck imports always ADD a profile: "Jetstream Custom", "copy", "copy 1" piled up, and the
prune ran before the import landed so it could not catch them.

**Decided:** `profile-store.ts` backs up the board's `.sdProfile` directory, quits Stream Deck (it
rewrites its profiles on quit, so a write while it runs is lost), rewrites only the changed keys on the
page the deck shows (`Pages.Current`), keeps every unchanged key's `ActionID`, title style and states,
relaunches, and while the app is down removes the leftover "Jetstream Custom" copies. Edits to
Jetstream slots still go live with no restart; the same restart migrates the older standalone
project/fleet/build keys to slots so their later edits go live too. The standalone stop-all key is
left as it is: the slot `stopall` kind is inert until `allowStopKeys`, so migrating it would quietly
disable a working key. The writer refuses any
profile that is not the Version 3.0 shape seen on Stream Deck 7.5. The import file remains only for a
first board, or a platform without the writer.

**Accepted trade:** a structural edit restarts Stream Deck for about five seconds, behind a confirm.

**TRIGGER to reopen:** Elgato documents a supported way to replace a profile, or a Stream Deck release
changes the ProfilesV3 shape (the writer then refuses, and chat falls back to the import file).

### Third-party keys (Philips Hue and the rest) are copied, not reimplemented

Chat told users it could not place a Hue key and sent them to the Marketplace, although the plugin was
installed and its key was already on their board. **Decided:** `plugin-catalog.ts` lists every
distinct third-party key already on the user's profiles; the model may place a copy by catalogue ref
only, and the uuid, settings, plugin block and states come from disk. **Rejected:** a native Jetstream
Hue kind (bridge pairing, a stored secret, an HTTPS surface, and it would hit the same macOS Local
Network block as Elgato's own Hue plugin, which was the real cause of the user's dead Hue key).

**TRIGGER to reopen:** a user needs a third-party key they have never placed anywhere.

### A page switch in the middle of a live chat apply is an accepted race

Chat plans against the page it previewed, and `applyLayout` refuses when the board reader sees
another profile or page at apply time (it cannot see a switch to a profile it skips, such as Ops).
Live edits still land on whatever key sits at that coordinate on the page on screen (`POST /slot`
matches visible keys), so a page switch while an apply's requests are in flight can change a key on
the new page. That window covers each request's render (an app-icon lookup can take about 500 ms)
and, after a failure, the rollback writes behind a 2-second request timeout.

**Accepted:** it needs a page-switch press during the second or two after the user confirmed the
apply. **Rejected for now:** a compare-and-swap on `/slot` (the client sends the settings it expects
at the key). It compares the plugin's settings with the profile read from disk, and if Stream Deck
flushes live edits to disk late, a later edit to a key whose disk copy is stale would be refused and
fall back to a restart.

**TRIGGER to reopen:** a user reports a chat edit that changed a key on a page they did not preview.

---

## 2026-08-09 — `1.1.1` stays untagged, and the guard that let it hide

Two calls from the first monthly supply-chain review.

### `1.1.1` is the one published version with no git tag — accepted, not back-filled

Tags on the remote start at `v1.2.0`; every version from 1.2.0 through 3.0.2 has one. `1.1.1`
(published 2026-07-16) has none, so the tree it shipped from cannot now be identified.

**Accepted.** 1.1.1 predates the automated release job, which cuts the tag inside `release`
only after `publish` succeeds — the gap is structural to the era, not a hole in the current
path. It is 25 versions superseded, and current `latest` is independently verified: the
published `dist/npm-cli-entry.js` is byte-identical to a fresh build from source, and the
package carries SLSA provenance from an OIDC publish by GitHub Actions. Back-filling would mean
pushing a tag onto a guessed commit, which manufactures exactly the certainty that is missing.

**TRIGGER to reopen:** anyone needs to reproduce or audit 1.1.1 specifically, or a second
untagged version appears (which would mean the release job's ordering broke, not history).

### The kill guard is strict on purpose — a substring match is not a lenient version of it

`isClaudeProcess` (`switchto.ts`) once returned `/claude/i.test(ps_output)`. It gates
`interruptPids`, reached from six deck handlers including interrupt-all with `board.allPids()`,
so the loose form authorised SIGINT against any process merely mentioning claude on a recycled
pid. It now shares `isClaudeCommand` with `probeClaudeProcess`.

**The reason this is written down:** relaxing it looks locally harmless and reads as a
false-negative fix ("the guard missed my session"). It is not. The failure it actually caused
was silent — the suite's own `interruptPids([process.pid])` test SIGINTed vitest's fork worker
on any checkout under a path containing "claude", and vitest reported the 12 lost tests as
`pending` with `numFailedTests: 0` and `success: true`. Only the exit code was red, and CI could
never show it because ubuntu-latest workspace paths do not contain "claude". A guard on a kill
path is not a matcher to be tuned; any doubt is "don't".

**TRIGGER to reopen:** a real Claude session is provably missed by `isClaudeCommand` — in which
case fix that one classifier, so the read and write paths keep one definition.

---

## 2026-07-25 — Loopback auth-transport cluster

Four linked findings from the 2026-07-22 security, test-suite and concurrency audits.
They were taken as ONE cluster because they interact: enforcing the token while two
processes can still mint rival tokens produces a 401 storm, and enforcing it without
fixing the permission-hook transport hands the token to a port squatter.

**Land them in this order — the sequence is load-bearing:** 1 (canonical mint) →
2 (enforcement) → 3+4 (permission-hook transport + its test).

### 1. `ensureToken` mints at one canonical path — DO IT NOW

`packages/jetstream/src/listener-token.ts:74`

The two `listener-token.ts` twins derive candidate paths by different rules — the plugin
from `projectsConfigPath()`, the hooks from an env-built list — under a "keep in sync"
comment. A process whose env yields `$XDG_CONFIG_HOME` mints there; a process without it
never looks there and mints a rival. Two secrets is worse than none: clients on the other
one present a WRONG token, which is rejected even during the grace period.

**Decided:** always MINT at `~/.config/jetstream/listener-token` — the one candidate every
list contains, in both packages, on every platform — while continuing to READ the full
candidate list. This keeps the settled adopt-don't-mint-a-rival policy untouched and makes
rival minting structurally impossible rather than sync-dependent. Also make the create
atomic (write a complete temp file, then `link()` it into place) so no reader can observe
a half-written token.

**Cost accepted:** the token no longer follows XDG/APPDATA the way the rest of the config
does. It is not user-editable config, and agreement between writer and reader matters more
than the convention.

**Amended 2026-07-25 after cross-review.** Minting at one path is NOT sufficient on its own.
Readers take the FIRST candidate holding a token, and each process derives its own candidate list
from its own environment, so a stale token at an earlier path keeps winning for whoever can see it.
The implemented design therefore makes the mint path AUTHORITATIVE and actively rewrites every
other candidate to match — convergence by equal bytes, not by ordering. Only a well-formed 64-hex
token is adopted or propagated, so a truncated or hand-edited file is healed rather than spread to
every location.

**Residuals accepted (all need an exclusive lock to close; none is newly introduced):**

- Two processes concurrently healing a blank mint file can end up holding different tokens. Blank
  files can no longer be _created_ by us now that the write is atomic, so this needs an externally
  corrupted file plus simultaneous starts.
- On a filesystem with no hard links the `wx` fallback restores the old create-then-fill window.
- A still-running predecessor keeps its cached token, so during a kill→respawn overlap a reconcile
  can briefly point hooks at the new token while the old listener still owns the port. Transient:
  it resolves when the old process exits.
- **TRIGGER to reopen all three:** a report of a dark board that `jetstream doctor` traces to
  mismatched tokens. Doctor now warns explicitly when candidates disagree, which is what makes
  these observable rather than silent — that warning is the reason they are acceptable.

### 2. `ENFORCE_TOKEN` flips to true, and the endpoint split extends to `legacy` — DO IT NOW

`packages/jetstream/src/listener-token.ts:18` and `:160`

No shipped build has ever authenticated the loopback. The grace period was specified as two
releases; the token shipped in 2.0.0 and the repo is at 2.1.4. (The real clock starts at
2.0.2 — 2.0.0 and 2.0.1 never reached any deck because of the manifest-version bug.)

Flipping as written would also go dark on `/hook`, because the endpoint split at line 160
rescues only the `no-secret` verdict — an untokened `legacy` client is refused everywhere.
A black board is the one outcome the token policy exists to avoid.

**Decided:** flip `ENFORCE_TOKEN` to `true` AND widen line 160 to `return endpoint ===
'status'`, so an untokened client keeps the status feed and loses `/permission` and `/slot`.
This applies the reasoning already settled for `no-secret` to `legacy` — same rationale,
same conclusion — rather than re-opening the split.

**Cost accepted:** a stale client can still colour keys wrongly, forever. `/hook` served
unauthenticated is already accepted policy: it only paints, and refusing it is what turns a
token problem into a dark board.

**Rejected — gather legacy-traffic evidence first.** `noteLegacyRequest` logs once, at warn
level, into the Stream Deck log, so there is no usable signal today. Building one would cost
another unauthenticated release and could not distinguish "nobody is stale" from "stale users
have not restarted Stream Deck recently."

### 3. The permission hook must verify who answered — DO IT NOW

`packages/status/src/permission-hook.ts:66`

The hook treats whatever answers `127.0.0.1:41321` as the authoritative permission decider
and re-emits its answer to Claude. Another local user who binds the port before Stream Deck
starts can return allow for every prompt — silent, unattended approval of every Claude tool
call, with no keypress and nothing shown on the board. Today the hook also sends its token
to that squatter, so enforcement alone makes this worse, not better.

**Decided:** challenge/response over the existing HTTP transport. The hook sends a random
nonce and NO token; the plugin answers with the decision plus an HMAC over nonce + body,
keyed by the shared secret; the hook recomputes and prints nothing unless it verifies. A
squatter cannot read the `0600` token file, so it cannot forge the signature — and printing
nothing is the existing safe fallback (Claude shows its own dialog).

**Rejected — migrate to a `0700` unix socket.** It closes the same threat class (another
local user) and no more: neither defends against a process running as you, which SPEC.md
already states. But it is a transport migration across the plugin, both hook binaries, the
CLI and the installer's `/health` poll, with a separate Windows named-pipe story. Too much
blast radius for the same win. SPEC.md already names challenge/response as an acceptable
shape; this narrows to it. **Do not re-propose the socket rewrite** unless the threat model
changes to include a same-user attacker, which the token does not defend against anyway.

**Known residual, accepted:** a squatter still receives the permission-request body, so the
tool prompt's contents leak. It cannot approve anything.

**Built 2026-10-06** (with #4): the hook sends a nonce plus HMAC-SHA256(token, "req\n" + nonce + "\n" + body)
instead of the token, so `/permission` keeps its decision-#2 authentication without the token ever
leaving the hook; the plugin answers with HMAC(token, "res\n" + nonce + "\n" + decision) and the hook prints
nothing unless it verifies (`packages/status/src/permission-client.ts`, tested through
`runPermissionHook`). The status hook stopped sending the token on `/hook` the same day (see 2026-10-06 above).

### 4. `permission-hook.ts` gets a tested seam — DO IT NOW

`packages/status/src/permission-hook.ts`

`main()` has no injectable seam, so the anti-injection contract — never echo the socket's
bytes, always funnel through `parsePermissionDecision`, print nothing on an unrecognised
answer — is enforced in this binary and tested nowhere. `parsePermissionDecision` is unit
tested; the wiring that uses it is not. Swapping the parsed value for the raw response passes
the whole suite.

**Decided:** extract `main` to take injected `readStdin` / `requestDecision` / `write`, and
test that a valid decision is re-emitted from the canonical writer and that a hostile or
unrecognised answer prints nothing. Fold this into decision 3 — the signature verification
cannot ship untested.

---

## 2026-07-25 — Remaining needs-decision items (2026-07-22 audits)

The four findings outside the auth cluster. Independent of it and of each other — land them
in any order.

### 5. Store-asset tests: keep the lint, drop the false coverage — DO IT NOW

`packages/jetstream/src/store-assets.test.ts`

These tests scrape `gen-store-assets.mjs` as SOURCE TEXT. On 2026-07-20 it was already decided
NOT to invest in making that generator importable (top-level Chrome side effects). **That
decision stands** — what changes here is only what the existing tests are allowed to claim.

**Decided:** split them by what they can actually detect.

- KEEP the palette-import assertion and the danger-red check. They are structural lint — "this
  file must not hardcode a status hex" — which is genuinely what they verify, and the same shape
  as `paint-discipline.test.ts`. Retitle them so they read as static checks, not behavioural
  coverage. (The audit's fix-now item — guarding the vacuous zero-match loop — still applies.)
- DELETE the 32-cell count. Counting `K(` / `BLANK` / `LOGO_CELL` / `TELEGRAM` tokens as a proxy
  for a rendered 8x4 grid cannot fail for the reason it claims: an inline cell not in the token
  list ships a 33-cell board green. A test that occupies the coverage slot without holding it is
  worse than no test.

**Accepted, not fixed:** a wrong colour MAPPING (as opposed to a hardcoded hex) still ships
undetected. These are marketplace gallery images, reviewed by eye before upload, and the cost is
an embarrassing screenshot rather than a broken install. Not worth a Chrome-driver harness.

### 6. Action registration gets a single checkable source of truth — DO IT NOW

`packages/jetstream/src/profile.test.ts:337`

The test derives "implemented actions" by regex-scraping `@action({UUID:'…'})` out of
`actions/*.ts`, and never consults what `plugin.ts` actually registers via `registerAction`.
Delete a `registerAction` call while keeping the decorator and the manifest entry and the key is
dead — the SDK answers nothing — with the suite green.

**Decided:** extract the registration list into a plain data module (`{ uuid, ctor }` entries)
that `plugin.ts` iterates, then assert THREE sets are equal: manifest UUIDs, decorator-scraped
UUIDs, and registry UUIDs. That closes drift in every direction and kills the whole class rather
than this one instance. Explicitly listing the uuid next to the class is redundant with the
decorator on purpose — the redundancy is what makes it checkable.

This is the same lesson as preferring `Record<ProjectStatus, X>` over if/else chains: turn the
invariant into a data structure something can actually check, instead of asserting over source
text.

**Rejected — import the actions barrel in the test.** It would boot `@elgato/streamdeck` side
effects inside vitest to learn something a plain array states directly.

### 7. `writeFleetFile` merges under the rename — DO IT NOW

`packages/jetstream/src/fleet.ts:141`

`projects.json` is read-modify-write-whole-file from three processes (the in-app fleet editor,
`jetstream chat`, `jetstream init`). The temp+rename gives per-write crash atomicity but no
cross-process reconciliation: `read()` and the rename are separate steps, so one writer's stale
snapshot atomically clobbers another's committed add. `mergeFleet` already exists and is simply
not applied on the in-app path.

**Decided:** re-read the file and apply `mergeFleet` immediately before the rename, inside
`writeFleetFile`, so every writer merges instead of clobbering. No new dependency, and it reuses
merge logic that is already tested.

**Rejected — a real lockfile.** The realistic collision is a human adding a repo in the app
while a chat session writes: seconds apart. Merge-before-rename covers essentially all of that.
A hand-rolled lock buys the last microsecond sliver in exchange for stale-lock recovery, which
is where the actual bugs would be — against a failure that already leaves a timestamped `.bak`
next to the file.

**Residual, accepted:** merge semantics mean a concurrent DELETE loses to a concurrent add — a
removed repo can come back. That is the correct bias: a resurrected repo is visible and one
click to remove, a silently lost one is not.

**AMENDED 2026-07-27 — the decision above is WRONG and was NOT applied. Do not apply it.**
`handleFleetMessage`'s `remove` case (`fleet.ts:284-294`) writes through the same
`writeFleetFile`, and `mergeFleet` is a union that keeps existing entries absent from the
proposal. Merging on every write therefore resurrects a deleted repo **always**, not only under a
race — it breaks removal outright. The "residual" above understated this as a race-only bias.

The correct fix needs the caller's BASE snapshot so the delta can be replayed onto freshly-read
disk state, which changes `writeFleetFile`'s signature. That is a design decision, so it stays open.

**And fixing `writeFleetFile` alone would NOT be enough.** It has only two call sites
(`chat-setup.ts:226`, `actions/settings.ts:161`); `jetstream init` is a THIRD writer that
reimplements the temp+rename inline (`init.ts:302-313`) and never calls the function — so it would
keep clobbering, and it does not write the `.bak` trail either. Anyone implementing this must route
init through the same writer first, or the fix will look complete while covering two writers out of
three. (This repo has been bitten by exactly that before: a fix is not fixed until you trace every
call path.)

Severity is also lower than the audit assumed: the writer with the long read→write window,
`jetstream chat`, ALREADY merges (`chat-setup.ts:335`). The two remaining writers read, mutate and
write microseconds apart. **TRIGGER to reopen:** a report of a repo vanishing from the board, or
any new third-party writer of `projects.json`.

### 8. Interrupt gets a cooldown and immediate feedback — DO IT NOW

`packages/jetstream/src/actions/interrupt-all.ts:31`

Every press re-sends SIGINT to every session PID with no cooldown or single-flight. The face
still reads "N working" until the next hook event or the 5s poll, so the press looks like it did
nothing and the user mashes; a second SIGINT to a still-busy `claude` within about a second is
escalated to a full session exit rather than a turn interrupt.

The audit filed this as needs-decision because Claude Code's double-Ctrl-C semantics could not be
verified. **That blocker does not hold:** re-sending SIGINT to a PID signalled 200ms ago is
useless under any semantics — either it is already interrupting and the repeat is redundant, or
it escalates and the repeat is harmful. The cooldown is right either way, so nothing needs
verifying first.

**Decided:** both halves.

- A per-PID cooldown (about 2s) INSIDE `interruptPids`, with an injectable clock. Placing it
  there rather than in the key handler covers all four call sites at once — `interrupt-all.ts:31`,
  `slot.ts:228`, `slot.ts:351` and `project.ts:91`.
- An optimistic repaint on press so the count visibly drops instead of waiting for the poll. This
  is the actual cure — mashing is a response to missing feedback, and `showOk()`'s checkmark does
  not change the number the user is staring at. It MUST go through `paintKey`; a raw `setImage`
  fails the `paint-discipline` guard and would strand the key with a stale cache entry.

---

## 2026-07-27 — Cross-review of the 2.1.5 update fix (shipped in 3.0.0 / 3.0.1)

Two findings from the Claude×Codex review of `npm-cli.ts`. Both are real and both were
knowingly shipped rather than fixed. Recorded so the next audit stops re-raising them.

### 9. `jetstream update` reasons about `import.meta.url`, not npm's install target — ACCEPTED

`packages/jetstream/src/npm-cli.ts:369`

`npm i -g` installs into the prefix belonging to whichever npm is spawned, but the version
comparison and the follow-on `installPlugin` both continue from the module that is _currently
running_. When those differ — Homebrew node against a `/usr/local` install, or invocation via
`npx` — npm updates one installation while this code inspects and reinstalls from the other. The
result is "Already on \<old>" plus a reinstall of the old bundle.

**Accepted, not fixed.** The wrong-target behaviour predates the 2.1.5 change, which only
replaced one inaccurate message with another; Codex downgraded its own HIGH to MEDIUM on that
basis. Fixing it properly means resolving npm's real global root (`npm root -g`) and re-sourcing
both the version read and the bundle from there — a design change to where `installPlugin` gets
its artifact, not a patch.

**TRIGGER to reopen:** an `update` that reports success or no-op while `jetstream --version`
disagrees, on a machine with more than one node/npm prefix.

### 10. `JETSTREAM_REGISTRY` credentials reach the process command line — ACCEPTED

`packages/jetstream/src/npm-cli.ts:365`

A registry URL of the form `https://user:token@mirror/` is accepted and passed twice in npm's
argv, where it is readable by any process that can see the process list.

**Accepted, and deliberately so — do not "fix" this without asking.** Inline credentials are a
supported escape hatch for a corporate mirror that requires them; `npm-cli.test.ts:671` asserts
it by name, and `redactRegistry` exists specifically to keep them out of printed output. Removing
it could break the only path by which a locked-down laptop can update at all. The safer
alternative — credentials in `~/.npmrc` — is not always available to the user.

**TRIGGER to reopen:** a shared or multi-user machine enters the threat model, or `.npmrc`
becomes a viable path for every environment that needs a mirror.

**Hardened instead (shipped in 3.0.1):** `%` is now rejected, because cmd.exe expands `%VAR%`
while parsing and would reintroduce the metacharacters the allowlist exists to exclude; and
structurally invalid URLs are rejected so a bad port names the setting rather than surfacing as
npm's own opaque error.

### Errata — commit `c85c077` overstates what it changed

Its message claims it rebuilt "the tracked sdPlugin bundle" because main's committed bundle still
had enforcement off. **That was wrong.** `packages/jetstream/.gitignore:2` ignores
`gg.pim.jetstream.sdPlugin/bin/` — the bundle is untracked build output and was never stale. The
claim came from a verification command whose failure mode was indistinguishable from a finding: a
`gh api` fetch of a path that does not exist in the repo returned nothing, and `grep -c` on that
empty stream printed `0`, which was read as "zero enforcement matches" rather than "no such file".

The commit's actual content is correct and was needed (the two workflow author fixes plus the
registry hardening); only its message overclaims. **Decided: leave it.** It is already pushed and
CI released 3.0.1 from it, and rewriting published history to correct prose would orphan tags for
no functional gain.
