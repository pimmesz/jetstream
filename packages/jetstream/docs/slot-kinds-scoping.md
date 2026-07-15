# Scoping: Fold structural Stream Deck keys into the plugin-owned `slot` action

**Goal:** every key becomes a `gg.pim.jetstream.slot` *kind* so `jetstream chat` retargets it LIVE via `POST /slot`, eliminating the `Jetstream-Custom.streamDeckProfile` re-import churn (a new "Jetstream Custom copy" per structural move).

**Root cause of the churn (confirmed):** `cli.ts:218` classifies `structural = placements.filter(p => p.uuid !== 'gg.pim.jetstream.slot')`. If **any** placement is structural, the live path is skipped (`structural.length === 0` gate at `:223`) and the whole board is rewritten to a new `.streamDeckProfile` and re-imported (`:246–253`). So *one* non-slot key on the board forces a full copy-import. Turning a key into a slot kind moves it from the structural bucket to the live bucket.

---

## 1. Target architecture

### 1a. `SlotKey` becomes a per-kind dispatcher — but stays timer-free

Today `SlotKey` (slot.ts) is purely event-driven: `onWillAppear` / `onDidReceiveSettings` / `onKeyDown` / `assign`, with a **pure** `slotFace(settings)` render and **zero timers / zero board subscription**. Three extension points grow:

- **`render()` / `baseFace()`** — add a `case` per kind. Two flavors:
  - *Pure-of-settings kinds* (`build`, `model`, `app`/`url`/`run` today): stay in the pure `slotFace()` path. `model` reads one global (`launchModel`) — thread it in as a param; don't let `slotFace` read global config (keeps purity).
  - *Live kinds* (`usage`, `ci`, `micmute`, `fleet`, `stopall`, `attention`, `review`, `heartbeat`, `permission`): `render()` branches to a kind face computed from **live state**, not settings. Extract each as a pure fn (`usageFace(feed, now)`, `ciFace(state)` already pure, `micFace(muted, known)`, `reviewFace(prs, missing)`, …) fed a cached value.
- **`onKeyDown` / `onKeyUp`** — a `switch (settings.kind)` before the existing `execPlan/runPlan` path. Adds inert kinds (`usage`/`ci`/`build`/`fleet` no-op), simple-press kinds (`stopall`→`interruptPids`, `micmute`→toggle, `model`→cycle global, `permission`→`settleHead`), and — only for `project`/`heartbeat` — a real `onKeyUp` + long-press timer, which `SlotKey` has never had.
- **kind-filtered repaint API** — `SlotKey.renderKind(kind)` scans `this.actions`, reads each visible instance's `getSettings()`, and repaints **only** matching-kind instances. This is what the tick/poll/subscribe sources call.

### 1b. The crucial decision: timers stay in `plugin.ts`, not in `SlotKey`

The per-key feasibility notes repeatedly warn of *"slot must run N polling timers keyed by kind"* leaks. **Avoid this entirely by never moving the timers into `SlotKey`.** Keep the poll/tick ownership exactly where it is today — `plugin.ts` — and only **redirect the repaint target** from the standalone key to `slotKey.renderKind(...)`:

```
// plugin.ts today                            // after fold
setInterval(ciKey.refresh, 60_000)      -->  setInterval(() => pollCi().then(() => slotKey.renderKind('ci')), 60_000)
renderBoard(): interruptAllKey.renderAll()   renderBoard(): slotKey.renderKind('stopall'); slotKey.renderKind('fleet'); …
permissions.subscribe(permissionKey…)   -->  permissions.subscribe(() => slotKey.renderKind('permission'))
```

Timer count stays **fixed and O(kinds)**, independent of how many slots carry a kind — the timer is one plugin-owned singleton per kind, and the poll state is one module-level cache per kind (shared across all slots of that kind, matching today's singleton semantics). `SlotKey` gains no `setInterval` and no teardown bookkeeping. The board tick gets a kind-filter so previously-static `app`/`url`/`run`/`build` slots are **not** repainted every 30s.

The one genuine exception: `attention`'s 1000ms flash and `project`/`heartbeat`'s long-press timers — transient, per-press (keydown→keyup) or escalation-scoped, living on the instance and torn down on release / kind-change. Bounded, not the leak the notes warn about.

### 1c. Shared pattern: pure face fns + behavior fns, reused by both action classes

- **Face:** extract every dynamic face into a pure `(...liveState) → Face` fn in the render layer. `ciFace` already is; `slotFace`/`baseFace` already are. Do the same for usage/mic/review/fleet/stopall/attention. Both `CiKey.render()` and `SlotKey`'s `ci` branch call `ciFace(sharedState)`.
- **Behavior:** the press effects are already mostly standalone fns (`interruptPids`, `resolveUsage`, `settleHead`, `runAfterburner`, mic `readInputVolume/writeInputVolume`). `onKeyDown`'s kind branch calls the same fn the standalone key does.

The standalone class and the slot kind become two thin call-sites over one shared core, which makes the coexistence strategy in §3c cheap.

---

## 2. Ranked migration table

### EASY-WINS BATCH — do first (pure/push faces, no board tick, no security gate)

| Key | Fold | Effort | What slot absorbs | Key risk |
|---|---|---|---|---|
| **build** | easy | **S** | One `SlotKind`+`baseFace` case slicing `BUILD_ID`; `onKeyDown` no-op. No timer, no settings. | Keep the `'dev'` (no-space) vitest fallback. None security-wise. |
| **model** | easy | **S** | `baseFace` case reading global `launchModel` (thread it in); `onKeyDown` cycles+persists global; one `config.subscribe`→`renderKind('model')` wire. | Global-vs-per-key semantics: two model slots aren't independent; repaint fan-out to all model slots **and** Launch keys. Security LOW. |

`build` is the single cleanest fold in the set; both prove the `SlotKind` plumbing + the cli live-vs-import win at near-zero risk.

### MEDIUM — live-face batch (grouped by refresh source)

**M-1 · Rides the shared board tick (no own timer, no gate):**

| Key | Fold | Effort | What slot absorbs | Key risk |
|---|---|---|---|---|
| **stop-all** | medium | **M** | `stopall` kind; face reads live board working-count; press→`interruptPids(board.allPids())`; join `renderBoard`. | Destructive fleet-wide SIGINT plantable via `/slot`. No exec, but consider an `allowStopKeys` gate. |
| **fleet** | medium | **M** | `fleet` kind; board-derived roll-up; press = showOk / doctor "why dark?" + 2.6s revert-from-live-settings. | Doctor/listener imports bloat slot.ts. Revert must repaint from current settings (reuse `repaint()`). No exec. |
| **micmute** | medium | **M** | `micmute` kind; async `readInputVolume()`→`micFace`; join `renderBoard`; **lift `restoreLevel`/`toggling` to per-coordinate**. | Per-coordinate `restoreLevel` correctness trap if shared. Needs per-key single-flight. Mute-only, likely no gate. |
| **attention** | medium | **M** | `attention` kind; board doorbell face; **its own 1s flash `setInterval` per slot** (transient); press = `openProject(board.attention()[0].path)`. | Per-key flash-timer lifecycle is the one new stateful bit. Ensure fold ignores a settings-supplied path. |

**M-2 · Own poll timer (kept in plugin.ts, singleton per kind):**

| Key | Fold | Effort | What slot absorbs | Key risk |
|---|---|---|---|---|
| **usage** | medium | **M** | `usage` kind; pure `usageFace(feed,now)` over module cache; plugin `usageTimer`→`renderKind('usage')`; preserve "no usage slot placed → skip `resolveUsage`" gate. | `resolveUsage` may spawn the afterburner subprocess — keep the placed-key gate. Shared feed: one resolve per cycle. |
| **ci** | medium | **M** | `ci` kind; hoist `CiState`+seq to module level; 60s `gh` timer→`renderKind('ci')`; preserve one-time new-failure `showAlert`. | Dispatcher now backed by shared mutable poll state + external `gh`. Seq stale-drop + one-shot flash must move intact. Read-only. |
| **review** | medium | **M** | `review` kind; pure `reviewFace(prs,missing)`; 120s poll→`renderKind('review')`; press opens top *ready* PR. | **Gate the auto-poll** — a planted review kind spawns the afterburner CLI on a timer unrequested. Press is safe (opens URLs, never merge). |
| **heartbeat** | medium | **M** | `heartbeat` kind; shared status cache; **`onKeyDown`+`onKeyUp` long-press** (short=re-poll, long=`run-once`); 60s timer→`renderKind`. | **MUST gate** — long-press fires a quota-spending, PR-opening `run-once`; via unauthenticated `/slot` = remote spend trigger. |

**M-3 · Push subscription (event-driven, no timer):**

| Key | Fold | Effort | What slot absorbs | Key risk |
|---|---|---|---|---|
| **permission** | medium | **M** | `permission` kind + per-key `decision`; face from `(decision, head(), count())`; `permissions.subscribe`→`renderKind`; press=`settleHead(decision)`. | **MUST gate (`allowPermissionKeys`)** — a planted body can flip `deny`→`allow`, auto-approving Claude tool permissions. **Privilege escalation, worse than run.** Existing profiles pin the UUID → alias/re-import. |

### HARD — defer (rich per-key settings + stateful async press)

| Key | Fold | Effort | What slot absorbs | Key risk |
|---|---|---|---|---|
| **project** | hard | **L** | Live board face + per-key `path`/`name`; board registration (currently `action.id`-keyed, not coordinate); **full two-stage long-press interrupt state machine**. | Planted key opens an arbitrary folder + SIGINTs matched PIDs → **needs a gate**. actionId-vs-coordinate identity mismatch; `assign()` full-replace must not orphan `board.setProject`. |
| **launch** | hard | **L** | `launch` kind + settings (`prompt`/`path`/`model`/`permissionMode`/`allowedTools`); async staged press with per-key in-flight `Set`; `runClaude` dep. | **Highest severity:** planted `/slot` runs `claude -p` with attacker-chosen prompt/cwd/`allowedTools` (Bash = arbitrary code exec + spend). **`allowLaunchKeys` default-off gate mandatory.** |

### SKIP — leave structural

| Key | Why skip |
|---|---|
| **nav** | Press is `switchToProfile` bound to manifest-declared bundled profiles + per-device deck resolution. Its *job* is switching Board/Ops pages, and `assign()` is **visible-only** (scans the shown page) — a folded nav could only be retargeted while its own page shows, so folding buys **no live-move benefit**, only a wider `/slot` attack surface (forced page yanks). |
| **settings** | In `NO_SETTINGS`/`renderAll` but not assessed; likely opens the PropertyInspector surface — treat as SKIP unless verified pure. |

---

## 3. Critical design decisions

**(a) Live kind's polling timer inside `SlotKey`? No — that's the whole safety of the plan.** Timers/subscriptions stay in `plugin.ts` (one singleton per kind); only their repaint target is redirected to `slotKey.renderKind(kind)`. Poll state stays a module-level cache per kind. Timer count is O(kinds), not O(slots), so the "N timers, N leaks" hazard never materializes, and duplicate-timer risk when multiple slots share a kind is *structurally impossible* (no slot owns a timer). Only per-instance timers are transient press/flash timers (`attention` pulse, `project`/`heartbeat` long-press), keydown/escalation-scoped.

**(b) Security — planted kinds must stay inert.** `/slot` is unauthenticated loopback and `assign()` does a **full `setSettings` replace**, so any kind is plantable at any coordinate. Follow the existing `allowRunKeys` precedent (slot.ts:107 — inert + "enable in settings" notice + 2.6s repaint-from-live-settings). Gating tiers:
- **Must gate (exec / spend / privilege-escalation):** `launch` (`allowLaunchKeys`), `heartbeat` (run-once spend), `permission` (`allowPermissionKeys` — worst, flips deny→allow), `project` (editor-open + SIGINT), `review` (auto-poll spawns CLI).
- **Consider gating (destructive, no exec):** `stop-all` (`allowStopKeys` — fleet SIGINT).
- **No gate needed (read-only / paint-only):** `build`, `model`, `usage`, `ci`, `fleet`, `micmute` (mute-only), `attention` (board-derived target) — for each, confirm the fold does **not** start honoring a settings-supplied path/command/target that would turn a safe kind into an exec vector.

**(c) Keep standalone action classes, or migrate profiles? Keep them, delegating to shared fns.** Existing profiles pin actions by UUID; deleting a class breaks already-placed native keys on restore. Refactor each standalone class into a thin wrapper over the shared pure-face/behavior fns (§1c), keep it registered for backward-compat, and route **new** chat placements to the slot kind. `build` is the safe exception (cosmetic, disposable) — its standalone action can be deleted as the canary for the delete path. `permission` additionally wants a UUID alias or one-time re-import so placed approve/deny keys survive.

**(d) Chat designer / `KEY_TYPES` change.** Folding = **repoint each type's `uuid` to `gg.pim.jetstream.slot`** in `layout.ts` and add a `build()` emitting `{ kind: '<kind>', ...slotCosmetics(f) }`. That single change flips the key from the `structural` bucket to `slotEdits` in `cli.ts:217–218`, so `onLayout` applies it live via `sendSlot`. `parseSlotCommand`/`SlotSettings` must widen its validated union to accept the new kinds (and `decision`/`target`/launch fields) — and that validation is now the security boundary for the `/slot` parser, so keep it strict.

---

## 4. Recommended first increment: `build` + `stop-all`

- **`build`** proves the *static fold* + the SlotKind/`baseFace` plumbing + the cli live-vs-import win at zero risk and zero refresh machinery.
- **`stop-all`** proves the *live board-tick render path* — the actually-new capability — with **no own timer** (rides `renderBoard`) and no mandatory gate blocking a first ship (wire `allowStopKeys` in the same PR). Exercises `renderKind()` + the board-tick kind-filter without dragging in osascript, per-coordinate transient state, or an external CLI.

**Concrete changes:**
- `slot.ts`: `SlotKind` += `'build' | 'stopall'`; `baseFace` cases; `render()` branches `stopall`→`stopFace(count)`; `onKeyDown` += `build` no-op and `stopall`→`interruptPids(board.allPids())`; add `renderKind(kind)`.
- `render.ts`: pure `stopFace(workingCount)`.
- `plugin.ts`: `renderBoard()` += `void slotKey.renderKind('stopall')`.
- `layout.ts`: repoint `build` and `stop-all` in `NO_SETTINGS` → slot `build()` entries emitting `{ kind }` on `uuid: 'gg.pim.jetstream.slot'`; add `allowStopKeys` handling analogous to the run-key note at `cli.ts:220`.
- `slot-command.ts` / `SlotSettings`: widen the validated kind union.
- `config`: add `allowStopKeys` (default false) + the inert notice mirroring slot.ts:107.
- Tests: `slot.test.ts` (build paints stamp + no-op press; stopall repaints on board change + `interruptPids` on press; stopall inert when `allowStopKeys=false`); `cli` (a layout of only `build`/`stopall` takes the live `sendSlot` path, no `.streamDeckProfile` written).
- `build.ts`: delete the standalone action + its `plugin.ts` registration (canary for the delete path); keep `interruptall`'s class (delegating) for backward-compat.

---

## 5. What this does NOT fix

- **`nav` stays structural — the copy-import path survives.** Any board containing a nav key (and the bundled Board/Ops profiles *do*) still hits `structural.length > 0` in `cli.ts:223`. The churn is *reduced in frequency*, not eliminated, as long as one structural key is on the board.
- **`project` and `launch` stay structural until the HARD work lands** — the two keys a user retargets most. The churn win is real for cosmetic/status/toggle keys but doesn't yet cover real-work keys.
- **Already-placed native keys don't auto-migrate.** Keeping the standalone classes means an existing `gg.pim.jetstream.ci` key is structural until re-placed via chat (or a UUID alias / migration ships). Folding makes *new* placements live, not retroactive.
- **Per-key settings kinds widen the `/slot` attack surface.** Folding `permission`/`launch`/`project` moves security-sensitive fields (`decision`, `prompt`, `path`, `allowedTools`) into an unauthenticated-loopback-writable settings union. The §3b gates contain this, but the surface is permanently larger.

**Flagged uncertainties:**
- `settings` key: verify whether it opens the PI (→ SKIP) before assuming foldable.
- `permission` UUID-alias/migration (do placed approve/deny keys survive a fold?) — unresolved, needs a decision before that key ships.
- `allowStopKeys` as a distinct flag vs. reusing `allowRunKeys` — a product call; lean distinct (SIGINT ≠ arbitrary exec).

_Relevant files: `src/actions/slot.ts`, `src/render.ts`, `src/layout.ts`, `src/slot-client.ts`, `src/cli.ts` (`onLayout`, 216–260), `src/plugin.ts` (`renderBoard`/`renderAll`/timers, 84–134)._
