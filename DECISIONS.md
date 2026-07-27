# Decisions

Durable record of design calls that would otherwise be re-litigated every audit.
Newest first. A decision here is settled — re-open it only against its stated trigger.

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
