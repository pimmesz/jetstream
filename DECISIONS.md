# Decisions

Durable record of design calls that would otherwise be re-litigated every audit.
Newest first. A decision here is settled — re-open it only against its stated trigger.

---

## 2026-10-09: verdicts on the 2026-10-08 audits' needs-decision items

The maintainer walked the needs-decision items of the security, test-suite, concurrency,
docs-drift and release-readiness audits one at a time: sixteen are to be built (ledger
`audit-decide-2026-10-09.md`), one is deferred and two are accepted. Two calls from the Claude x
Codex cross-review of that build are recorded at the end. Where a verdict below
contradicts an older entry, this one wins.

- **Always-Allow scope** (security `authz-authn-1`, `permissions.ts:67`): DO IT. A Bash rule is keyed
  on the exact command and on whether the sandbox was off, and a compound command cannot be armed.
  Compound means `;`, `|`, `&` (not `2>&1` or `&>`), a backtick, a newline or any `(`, `)`, `{`, `}` or `[[`: zsh can
  run code from many bracket forms (`=(`, `always` blocks, glob qualifiers), so any bracket is the
  simple safe line, and a bracketed one-liner such as `jq 'map(.x)'` is the accepted false positive.
  A compound command that does not fit the face or spans lines is left to Claude's own dialog. The
  fit is estimated from rough character widths (18 average characters; capitals, CJK and emoji count
  wider) and errs toward marking: an extra `*` or an extra trip to Claude's dialog is the accepted cost. Other tools keep the session + tool key. Replaces "TOOL-scoped" in the permissions.ts note.
- **Live /hook payload** (security `secrets-1`, `status-hook.ts:34`): DO IT. The live POST sends the
  same projection as the spool, and a stdin body that is not a JSON object is neither posted nor
  spooled. Supersedes "the live POST is unchanged" in the hook spool entry.
- **MCP Actions profile** (security `authz-authn-4`, `README.md:165`): DO IT. The README stops
  suggesting APPROVE there and warns against it: an agent could approve its own prompt.
- **Chat Text key** (security `input-validation-1`, `layout.ts:125`): DO IT. Control characters are
  refused and the preview shows up to 40 characters, ending in an ellipsis when it cuts.
- **Home path in the bundles** (security `info-disclosure-4`, `build.mjs:32`): DO IT. The build
  rewrites the repo-root prefix after esbuild runs; `absWorkingDir: tmpdir()` stays.
- **installHooks compare and rename** (concurrency `check-then-act-1`, `file-write-races-1`,
  `hooks-install.ts:339`): DO IT, and the residual is accepted. The compare and the rename run
  synchronously back to back, which narrows the window but cannot close it: POSIX has no
  compare-and-rename and Claude Code takes no lock.
- **Ctrl-C during chat's restart write** (concurrency `cancellation-cleanup-1`, `profile-store.ts`):
  DO IT. While the profile-write lock is held, a signal is deferred until Stream Deck is relaunched
  and the lock released, then the CLI exits 130; a second signal exits at once. The lock is still
  never taken over automatically.
- **Token tests** (test-suite `name-vs-behavior-1`, `listener-token.test.ts:287`): DO IT. They pin
  the settled values from 2026-07-25 #2; the "both arms" reason expired with the flip.
- **Paint lint** (test-suite `source-text-asserts-1`, `paint-discipline.test.ts:30`): DO IT. The
  lint stays and widens to `src/**` and `.setImage?.(`; fake-timer revert tests for the transient
  faces are added beside it.
- **Store-asset red** (test-suite `source-text-asserts-2`, `store-assets.test.ts:52`): DO IT. The
  generator imports `DANGER_RED`. Amends #5: the danger-red check now asserts that import.
- **Action UUIDs** (test-suite `source-text-asserts-3`, `profile.test.ts:354`): DO IT. The
  implemented set comes from the registry's `manifestId`s. Amends #6 again.
- **Prefs regex** (test-suite `coverage-gaps-8`, `board-layout.ts:190`): DO IT. Checked by hand
  against real Stream Deck 7 output on 2026-10-09; the parser becomes a pure function with a test.
- **Lock test stopwatch** (test-suite `flaky-patterns-5`, `settings.test.ts:200`): DO IT. A tick
  counter replaces the 50 ms bound.
- **Multi-actions** (docs-drift `claims-features-2`, `docs/v2-roadmap.md:54`): DO IT. Approve/Deny
  and Settings set `SupportedInMultiActions: false`.
- **Stale core builds in tests** (test-suite `harness-correctness-2`, `vitest.config.ts:10`):
  ACCEPTED. Only a bare local `pnpm test` after a core src edit can read an old build; `pnpm check`
  and CI build the cores first. Reopen if a mutation run needs cross-package targets.
- **Release ships main's tip** (release-readiness `gates-2`, `install-repro-2`, `artifacts-2`,
  `smoke-2`, `ci.yml:147`): DO IT. A run skips its release when main moved past the gated commit
  in shipped paths (bot bump and landing-sync commits ignored); the newer run releases. Narrows
  the ci.yml:145 "main's tip" choice to the version number it was meant for.
- **Marketplace build** (release-readiness `gates-5`, `install-repro-3`, `artifacts-4`,
  `metadata-3`): DO IT. CI attaches the `.streamDeckPlugin` prepack built to the GitHub Release
  and the manual upload uses that file. "Manual by design" (MARKETPLACE.md:118) now covers the
  upload only.
- **Unverifiable release checks** (release-readiness `gates-1`, `install-repro-1`,
  `artifacts-1`, `secrets-scan-1`, `secrets-scan-2`, `smoke-1`): DEFERRED. The audit collector
  cannot execute on a pnpm 11 workspace, so CI's build job on the pushed commit is the gate
  record. TRIGGER: the collector is fixed for workspaces; then re-run release-readiness.
- **Slot inspector label and colour on app keys** (cross-review X5, `slot-inspector.ts:49`): HINT ONLY.
  An app key keeps showing the app's own icon; the inspector says its label and colour show only when
  the app has no icon. Rendering them over the icon would change every app key that chat styled.
- **Early relaunch after a deferred signal** (cross-review C11, `profile-store.ts:307`): ACCEPTED.
  A signal ends the quit-wait, so Stream Deck can be told to launch while the old instance is still
  closing. Plausible in every check and never reproduced; reopen if a relaunch is seen to be lost.
- **4.1.1 as a patch** (release-readiness `semver-3`, DECISIONS.md "deferred fixes built"):
  ACCEPTED. Every item in that batch fixes a residual recorded at the 4.1.0 ship and adds no
  command, flag or setting; adopting the shell's config dirs fixes a documented limitation.

---

## 2026-10-08 (later): deferred fixes built (4.1.1)

The maintainer asked for eight items that the review fixes below left as residuals to be built,
with every recommended default. They ship as one `fix:` commit (CI bumps 4.1.0 to 4.1.1):
`/challenge` and the two new `~/.jetstream` files are internal, and the npm package exposes only a
bin. Each item names the earlier line it supersedes; the older text stays as history.

**Restart write compares against disk** (supersedes the 2026-10-08 residual "After a failed live
apply, the restart fallback still writes by coordinate without comparing against disk"):

- After the quit and inside `profile-write.lock`, the in-place write compares only the coordinates
  it writes (the user's edits plus folded legacy migrations) against the page Stream Deck saved on
  the way out (`changedSincePlan` in chat-apply.ts, passed to `writeInPlace` by cli.ts).
- A key passes when disk holds what the plan saw there (chat's pending live edits laid over it) or
  what this write puts there, each as sent or, for settings `/slot` accepts, in the plugin's stored
  form. That accepts the four forms a failed live apply leaves behind: `{}` back as
  `{kind:'empty'}`, a styled spacer back without its colour, an unconfirmed undo still holding the
  placement, and a saved pending edit. Settings `/slot` refuses (a folded legacy url without a
  scheme) never went live, so they compare only as sent. Slots compare with `sameSlot`; other keys
  compare UUID and Settings deeply and ignore the rest.
- **Decided:** any changed key aborts the whole write, legacy migrations included, and nothing is
  written. A plan is all or nothing, like the live path. Chat names the keys and asks for the request
  again; it never re-plans on its own, because the model's placements encode the old board.
- The compare also covers restart writes that were never tried live (an all-restart plan, or a deck
  edit made after the preview).

**Pending live edits outlive the chat** (supersedes the 2026-10-08 residual "Pending live edits live
inside one `jetstream chat` process" and the 2026-10-06 residual "Chat forgets its pending live
edits when you switch page mid-chat"):

- Pending edits live in `~/.jetstream/chat-pending.json` (`{ version: 1, edits: [...] }`, written
  atomically, 0600), keyed by profile directory and page. Chat reads them at start and after every
  real re-read, and writes them whenever it records or forgets an edit.
- **Decided:** each edit stores the pid of the chat that made the latest live edit to that key, and
  never expires while that chat runs (`process.kill(pid, 0)`), since Stream Deck can hold an edit
  unsaved for longer than any TTL. A 1 h TTL, counted from that latest edit, applies only once that
  chat is gone, and only clears out edits a crashed or abandoned chat left behind; disk evidence
  stays the forget rule. This replaces an own-edit exemption kept in memory, which any other chat's
  save ignored. The file sits with the other disposable runtime state, not in `~/.config/jetstream`
  (user config, token, backups).
- A key laid over from the store is never trusted as unchanged. Chat sends it again with `expect`
  set to the pending settings: if Stream Deck kept the edit that is an idempotent 200, and if it lost
  the edit the plugin answers 409 in the destinations phase, before any key is cleared. On the
  restart route the key is written too, so the compare sees the mismatch on disk and calls the write
  off (`reloaded`). The preview shows such a key as e.g. `a2: x.dev (was: x.dev)`, not "Already set".
- After a 409 at a key with a stored edit, chat forgets exactly the edit its plan saw (matched by its
  time and chat pid, not its settings), so an edit another chat stored there since the plan, even an
  identical one, is kept. The next request plans against disk. A lost edit costs one false 409.
- When a plan clears or replaces any key that holds something, every unchanged key it keeps is
  confirmed first: live, each unchanged Jetstream slot is sent on its own, before any other key, with
  `expect` set to what the plan saw, and a refusal stops the apply before any key changes; on the
  restart route the disk compare covers every kept key, third-party keys included. A confirm rewrites
  only what the key already held, so it is never undone. A move can therefore never lose its only
  copy, whether its source is cleared or overwritten, after a lost edit, a partly expired store or a
  key forgotten after a 409 caused by another page on screen.
- "A wrong TTL only ever costs a false 409 or a false 'Already set', never a wrong write" holds
  only because of these rules: without them, a crash-lost edit laid over a move's destination let
  the move clear the source and report success, and asking again got "Already set" or the same 409
  every time.
- Otherwise the keep, overlay and forget rules are unchanged. Keying by page replaces "forget
  everything on a page switch": overlays still never cross pages or profiles, and going back to a
  page before Stream Deck saves now plans correctly.
- **Decided:** the clears after a `restarted` or `reloaded` outcome stay per page. The quit saves
  every page's held edits, so disk shows them and the disk rule forgets them when that page is next
  read. Only edits Stream Deck lost before that restart remain, and those cost at most one false 409
  before the 409 forgets them.
- The forget rule runs only on a board that was really re-read. When a re-read finds no board, chat
  keeps the previous board and lays the stored edits over it without forgetting any, so the turn's
  own live edit is not lost and turned into a false 409.

**The in-app fleet editor waits without blocking** (supersedes the 2026-10-08 "Fleet and npm" bullet
"The in-app editor waits about 100 ms for the fleet lock" and the plugin half of the residual
"`jetstream chat` and `init` wait for the fleet lock synchronously"):

- The editor waits for `projects.json.lock` asynchronously (`writeFleetFileAsync`): its 25 ms pauses
  yield to the event loop, so keys, `/hook` and `/permission` keep running. With a free lock the
  take, replay, rename and release still run in one synchronous turn. The lock file protocol is
  unchanged, so a 4.1.0 CLI and this plugin still wait for each other, and the CLI path is unchanged.
- **Decided:** the same 3 s budget as `jetstream chat` and `init`. Waiting out a crashed writer's 10 s
  stale lock would leave the inspector silent that long.
- Inspector fleet messages run one at a time (`fleetQueue` in SettingsKey), so a message sent while
  a save waits on the lock reads projects.json only after that save. Without the queue, a re-add
  judged against the stale read was a no-op "duplicate" and the pending removal won. list and scan
  queue too, so replies keep send order; the cost is that each queued message also waits out every
  save queued ahead of it, up to 3 s each while the lock is held.

**Shell-only config dirs reach the plugin** (supersedes the 2026-10-08 residual "A
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` set only in a shell is documented, not handled", and the README
claim in "Docs and style" that the plugin does not see them):

- The CLI records the shell's `CLAUDE_CONFIG_DIR` and `CODEX_HOME` in `~/.jetstream/shell-dirs.json`:
  the npm front door on `install` and `update` (before the plugin is handed over or npm runs), the
  plugin CLI on `chat`, `init`, `setup` and `hooks install`. The record mirrors the last recording
  shell: exactly its usable keys, removed when it sets neither, rewritten only when it differs.
- **Decided:** the plugin adopts the record into its own `process.env` at boot (the first statement
  in plugin.ts), only for keys its env leaves empty, so `launchctl setenv` always wins. Every resolver
  reads the env when called, so auto-wire, Fix, tool detail, the checklist, the hints and the Codex
  gauge all switch with no other edit. Rejected: a resolver at each call site, where the next plain
  `defaultSettingsPath()` brings the bug back. `doctor` stays read-only, as documented.
- Only the CLI writes the file, from its own env, atomically and 0600; the listener, the inspector,
  the hooks and chat's model output never do. The plugin refuses a symlink (`O_NOFOLLOW`), a
  non-regular file (`O_NONBLOCK`, so a FIFO cannot hang boot), a file over 4 KB, one owned by another
  uid, and one that is group- or world-writable, and any value that is not absolute, is over 1024
  chars or holds control characters. Unknown keys are ignored, so a record cannot set `NODE_OPTIONS`
  or `PATH`. Windows has no uid or mode check and no `O_NOFOLLOW`; the profile folder's ACL does that.
- A writer can redirect which settings.json the plugin writes its own fixed hook JSON into, which
  settings.json the checklist and hints read, and which sessions tree the Codex gauge reads. Adopted
  values also reach the plugin's children (run keys, editors, discover, the Windows terminal
  launcher), the same reach as the README's own `launchctl setenv`. Only a same-uid writer can do
  any of this, and it can already edit `~/.claude/settings.json` or the shell profile, so there is
  no new capability. `WIRE_VERSION` is unchanged.

**Reducer edges** (status reducer and `replaySpool`):

- An agent's own empty-list SubagentStop no longer tombstones its id, so a resumed agent that reuses
  it is tracked again. Corrected trigger: no lost SubagentStop is needed, only a resumed agent
  reusing its id within 30 min (that the id stays the same is inferred from the hook contract).
- A SubagentStart that fired before the newest applied empty `background_tasks` list is not planted.
  The cutoff (`emptyList`, in memory) only moves forward.
- A Stop (or any event but SessionEnd) with an empty list that arrives after a newer event keeps the
  newer status, `since` and `firedAt`, but still ends the agents that started before it.
  `replaySpool` now passes such a stale event through; a stale SessionEnd is still skipped.
- `emptyList` lands in the checkpoint, but `Board.restore` ignores it, so it is dropped on restart
  like `inflight`. No hook, protocol or spool change.

**The plugin exits when Stream Deck disconnects** (corrects the 2026-10-08 bullet "The checkpoint is
flushed on process `exit`": a disconnected plugin did not always exit on its own):

- SDK 3.0.1 reports no socket close, never reconnects and keeps the socket private, so a held
  `/permission` (a ref'd 90 s timer) kept a disconnected plugin on the hook port, answering hooks
  meant for the next instance. `onStreamDeckClose` (plugin-wiring.ts) finds the socket through Node's
  built-in `net.client.socket` diagnostics channel by matching argv `-port`. plugin.ts subscribes
  before `connect()` and exits on the close; the exit flush is now registered before `connect()` as
  well, so that exit writes the checkpoint. The port frees within milliseconds.
- **Decided:** rely on that channel. The diagnostics_channel API is stable, but Node marks its
  built-in channels experimental; if one is renamed, the watcher never fires and behaviour falls
  back to today's (the Node 24 tests would catch it). Held prompts get a socket reset instead of a
  204, with the same outcome for the hook: it prints nothing and Claude's dialog decides.
- Live hooks the restore gate still holds at the close are spooled before the exit
  (`spoolHeldHooks` in plugin-wiring.ts, spool fields only), and the next instance replays them in
  fire order. They were answered 204, so their hooks spooled nothing themselves. They are never
  applied to the board, which has not merged the checkpoint yet.

**Signed challenge (v2)** (narrows the 2026-10-08 residual "A signed request a squatter captured ...
can be replayed", and its unsigned `/slot` answer, to clients that still send the 4.1.0 format):

- Clients first GET `/challenge`: 64 hex (12 hex issue time on the plugin process's monotonic clock,
  20 random hex, a 32 hex HMAC tag under a per-listener secret), so issuing stores nothing and a
  flood of GETs cannot push out a client's challenge, and a wall clock stepped back cannot reopen a
  claimed one. Single use, through a used set filled only after the request MAC matched (at most 1024
  inside the 60 s life, refused rather than forgotten when full); 60 s life; open behind the Origin
  guard, sent no-store. The request MAC is HMAC(token, `v2\n<kind>\n<challenge>\n<nonce>\n<body>`),
  checked before the challenge is claimed.
- Answers are signed: `res` for `/permission`, and `slot-res` over `<status>\n<body>` for every v2
  `/slot` answer (200, 400, 404, 409, 500). The client nonce is in every MAC, so an answer verifies
  only for the request that asked. Clients never fall back to the unchallenged format, and the GET
  and the POST each use their own connection, so a squatter that answered the GET cannot relay a real
  challenge and keep the signed request. `sendSlot` believes an unsigned 401; any other answer
  without a valid MAC is -1, which chat treats as no answer and rolls back.
- Every client loopback call has a deadline for the whole request (`AbortSignal.timeout`), not
  only a socket timeout, which each dripped byte restarts: `pluginAlive` (800 ms), both `sendSlot`
  requests (2 s each), the permission hook's challenge GET (2 s) and permission POST (110 s), the
  status hook's `/hook` POST (1.5 s, still counted as delivered when it times out) and the update
  health poll (800 ms). An answer dripped a byte at a time, or an endless `102 Processing`, still
  ends.
- **Decided:** the plugin keeps accepting the 4.1.0 signed format on the unchanged nonce path, like
  the token header ("Loopback auth" below). Refusing it is a breaking change, and it would silently
  drop deck approvals from hooks wired from another folder or during the update window. Both are
  retired together in a later major.
- Cost: one extra loopback GET per permission prompt and per live edit. Mixed versions: 4.1.0 has no
  `/challenge` route and treats the untokened GET as a sensitive request, so it answers 401 and logs
  its one-time "untokened loopback request" warning (its `jetstream hooks install` hint does not
  apply here: updating the plugin does). A new hook then prints nothing and Claude asks in its own
  dialog; a new CLI says to update the plugin, then offers the restart write. A 4.1.0 hook or CLI
  against this plugin works on the old path.

**Two decks** (`/slot` deck filter):

- Every live `/slot` edit and rollback body carries `deck`, the board's model key (`mini`,
  `standard`, `xl`), placed after the settings spread so a settings field cannot override it. The
  plugin only considers slot keys on a device of that model. An unknown value or null matches
  nothing, and a deck the plugin cannot map (Stream Deck +, Virtual Stream Deck, Pedal) never matches
  a named one.
- **Decided:** when more than one slot key is left at the coordinate (two decks and no `deck`, or two
  decks of the same model), the plugin answers 404 "`<coord>` is a slot key on more than one Stream
  Deck" instead of guessing. 404, not 409, because every released chat reads 404 as "nothing
  changed" and offers the restart write; a 409 would make 4.1.0 suggest a retry that can never
  succeed, and make 4.0.0 roll back and report false "unrestored" keys. Chat's 404 line now names
  the two-deck case.
- **Rejected:** exact device-id targeting (that the SDK's `device.id` equals the manifest
  `Device.UUID` is unconfirmed, and a wrong guess would 404 every live edit), and picking the
  candidate whose settings equal `expect` (it can land on the deck that was not previewed).

**Claude x Codex (gpt-6.1-sol, gpt-6-astra) cross-review of the batch:** nine findings, each
confirmed by both with a repro and fixed above with a test that fails without the fix, or corrected
here.

- Y1: a pending key that matched the request was planned as unchanged, so after Stream Deck lost
  that edit, a move onto the key cleared the source and reported success. Pending keys are re-sent.
- C1: a lost pending edit stayed laid over (for an hour, or for good in the chat that made it), with
  a false "Already set" or the same 409 on every retry. A 409 now forgets it.
- C2: the restart compare read settings `/slot` refuses as an empty slot, so an empty key dropped
  over a folded legacy url passed and the url came back. Only settings `/slot` accepts are normalised.
- C3: another chat's save deleted a running chat's edits older than an hour, because the own-edit
  exemption lived in memory. Edits carry their chat's pid.
- C4: the exit on a Stream Deck close dropped live hooks the restore gate held and had answered 204.
  They are spooled.
- C5: a flood of unauthenticated `GET /challenge` evicted live challenges, failing v2 deck approvals
  and live edits with a "token mismatch" message. Issuing is stateless.
- X1: a fleet message sent during a lock wait read the old file, so a remove then a re-add of the same
  repo lost it. Fleet messages are queued.
- X2: client loopback calls had only an inactivity timeout, so a squatter dripping its answer could
  hang chat (already possible through `pluginAlive` in 4.1.0). Every client loopback call, the
  status hook and the update health poll included, has a whole-request deadline.
- C6: the restart-compare residual said an abort uses one of the 5 kept backups. The write returns
  before the backup, so an abort costs only the restart.
- Also corrected: a `sudo` run writes no shell-dirs record (the CLI skips uid 0), not a root-owned one.

**Residuals accepted:**

- Restart compare: a third-party key at a replaced coordinate that rewrites its own Settings causes
  a false abort; sending the request again fixes it unless that plugin rewrites constantly. An abort
  costs one Stream Deck restart (about 5 s), because the compare can only run after the quit
  (comparing earlier would miss unsaved deck edits). "Stream Deck restarted, but nothing was
  written" is printed even when Stream Deck was not running.
- Pending edits: two chats saving in the same few ms can lose one chat's entry. A 4.1.0 or older
  chat writes no file, so a new chat right after its live edit still gets one false 409. A file that
  cannot be written turns the store into memory only without a message, and a missing, corrupt or
  unknown-version file reads as empty. A pid reused after its chat quit (after a reboot, say) keeps
  that chat's edits fresh. An earlier chat's edit that expires during a turn drops the `before`
  chain of this turn's edit at that key, so chat forgets its own edit; that needs the earlier chat
  gone and the edit unsaved for an hour. Each costs at worst one false 409 with the existing advice.
  The file holds the same slot settings as the profile (URLs, app paths), hence 0600.
- Pending edits, 409: a 409 caused by another page on screen (a page switch not yet on disk) also
  forgets a still-valid edit, and that key then gets a false 409 on each try until Stream Deck saves
  or a restart is accepted, the same class as the page-switch residual. When a re-read finds no
  board, chat keeps the previous board, so a key forgotten after a 409 still shows the lost edit
  there, and gets the 409 again, until a board is read.
- Fleet: for up to 10 s after a writer crashes holding `projects.json.lock`, an in-app add or remove
  waits the full 3 s and then says "try again", and every fleet message sent meanwhile waits behind
  it, each queued add or remove for its own 3 s after the one ahead; the inspector shows no progress
  during that wait.
- Shell dirs: the last recording shell verb wins, so a direnv or mise env that exports
  `CLAUDE_CONFIG_DIR` inside a repo moves the record. One dir per key, so multi-account users run
  `hooks install` from each env. A change applies at the plugin's next start, and changing
  `CLAUDE_CONFIG_DIR` after the first launch does not re-run auto-wire (`jetstream hooks install` or
  the in-app Fix wires the new dir). The first `jetstream update` from 4.1.0 runs the old npm
  wrapper, which does not record; the next CLI verb does. A `sudo` run (uid 0) neither writes nor
  removes the record, since sudo drops the user's env.
- Marketplace-only installs that never run the CLI still need `launchctl setenv` (or the symlink),
  as README says. Covering them would mean spawning a login shell from the GUI process at boot,
  which is slow, can hang on a profile prompt and runs arbitrary profile code.
- Reducer: the clock-step residual below now cuts the other way. A backward clock step after an
  applied empty list can stamp a Start before the cutoff, so it is ignored and the key can read done
  or idle while that agent runs (before, the same step could only cause a false "working" for up to
  30 min). It needs a backward step landing in a gap of milliseconds to seconds.
- Disconnect: it depends on `net.client.socket` and is a no-op if Node renames that channel. A
  `/hook` POST accepted at the instant of the close is lost (unchanged); hooks the restore gate held
  are spooled, and one with no `_at` (a hook older than that stamp) replays as of the next
  instance's start. In a fast in-app restart the successor can restore a few ms before the old
  process's exit flush (narrower than before).
- Signed challenge: a captured 4.1.0-format signed request can still be replayed once within its
  2-minute window, and a 4.1.0 CLI's `/slot` answer stays unsigned, until a later major retires the
  4.1.0 format together with the token header. More than 1024 genuine v2 requests inside 60 s are
  refused until the oldest expire; only a token holder can fill the used set. The hook still reads
  the `/permission` answer with no size cap: a squatter can make that short-lived hook die, and
  Claude's own dialog then asks, the same as for any answer it refuses.
- A request for a key's pre-edit value is answered "Already set" while Stream Deck still holds an
  unsaved live edit there that a 409 from another page made chat forget. Nothing is written; the
  next request after Stream Deck saves plans correctly.
- Two decks of the same model refuse live edits at a shared coordinate and always take the restart
  route. An older chat (no `deck`) with slots on two decks at one coordinate gets 404 and the
  restart. A 4.0.0 or 4.1.0 plugin ignores `deck` and keeps its first match until it is updated.

**TRIGGER to reopen:** a report of a false "changed since the plan was made" abort, or of a 409 at
the same key on every try; the SDK's `device.id` shown to equal the manifest `Device.UUID`, or a
user with two decks of the same model asking for live edits; Node renaming `net.client.socket`; the
next major release (retire the 4.1.0 signed format and the token header).

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
