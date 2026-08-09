# Decisions

Durable record of design calls that would otherwise be re-litigated every audit.
Newest first. A decision here is settled — re-open it only against its stated trigger.

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
