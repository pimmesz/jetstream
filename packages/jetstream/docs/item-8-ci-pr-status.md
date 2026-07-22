# Jetstream v2 — Item #8: CI/PR status key

> **Superseded — BUILT, then REMOVED 2026-07-20.** Build record only; do not re-propose. See the removal list in SPEC.md.

**Status: BUILT.** A v2 Opus-tier item, first link of the roadmap's "own the loop past done"
bet (diff badge → **CI/PR status** → ship-as-PR). Closes the gap between a green "done" key
and an actually-mergeable PR. Built the pull design below (standalone `CiKey` singleton +
`gh` poll); the pure classifier/roll-up is unit-tested, `streamdeck validate` passes. Remaining:
on-device verification against a real open PR, and (deferred) making the branch prefix + poll
cadence configurable rather than the hardcoded `afterburner/` / 60s.

## Why

A Project key going green means Claude *finished* — not that its PR's CI passed. #8 adds a
key that polls the open PR's checks and shows **spinner / green / red**, flashing on a new
failure, so "done" becomes "actually green."

## Shape (resolved design forks)

- **Key shape → a new standalone singleton `CiKey`** (`gg.pim.jetstream.ci`), like Fleet /
  Attention / Usage. The roadmap phrases #8 as a single spinner/green/red key with
  flash-on-failure (Attention-style), not a per-Project-key badge. Keeps the crowded
  Project key untouched.
- **Push vs pull → pull (the plugin shells `gh`).** Jetstream is standalone by design
  (SPEC: "afterburner is NOT a dependency — just a project path on the board"); a push
  transport would couple afterburner core to jetstream's loopback port and only cover
  afterburner-opened PRs. The roadmap literally says "poll `gh`", and `diffstat.ts` already
  shells a subprocess (`git diff --numstat`) from the plugin — direct precedent.
- **Which PR → the worst CI state across each configured repo's open PRs whose head branch
  matches a prefix** (default `afterburner/`, a plugin setting so jetstream stays
  afterburner-*aware* without an afterburner *dependency*). Rolls up across `board.projects()`
  — which, post item-G, already covers the seeded fleet. Mirrors the Fleet key's "worst wins".

## Deliverables

**Pure core (`src/ci-status.ts`, gate-tested — the heart):**
- `type CiState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown'`.
- `classifyChecks(rollup): CiState` — pure, **fail-closed** on untrusted `statusCheckRollup`
  JSON. Precedence `failing > unknown > pending > passing`; empty array → `none`; non-array /
  unrecognized element → `unknown` (never claim `passing` when something's unreadable).
- `worstCi(states[]): CiState` — roll-up across PRs/repos, precedence
  `failing > pending > unknown > passing > none`.
- `ciFace(state): { color; glyph; label; sub }` — pure state→face mapping.

**Poll (`src/ci-status.ts`, IO — mirrors `diffstat.ts` exactly):**
- `readRepoCi(cwd, branchPrefix, gh?): Promise<CiState>` — injectable `gh` exec, `execFile`
  **array argv** (never a shell string), short timeout + `maxBuffer`, returns `'unknown'` on
  ANY error (missing gh / auth / network / bad JSON). No untrusted text reaches argv; if a PR
  number is ever used it's `Number.isInteger`-validated first.

**Key + wiring:**
- `CiKey` SingletonAction: polls the fleet on the plugin timer, renders `ciFace`, **flashes
  only on the transition into `failing`** (not every poll). Registered in `plugin.ts` with its
  own poll interval; new `manifest.json` action + SVG.
- Optional `branchPrefix` + `ciRefreshSec` in the config (defaults `afterburner/` / 60s).

**Doctor:** a `gh` presence/auth check (the PATH caveat below), so `jetstream doctor` explains
a persistent `unknown` face.

## The PATH caveat (honest limit)

The plugin runs as the Stream Deck app's node process, which on macOS typically inherits a
minimal PATH (`/usr/bin:/bin:…`) lacking `/opt/homebrew/bin` where `gh`/`git` live. So the
`gh` poll may silently fail on some installs. Mitigation: degrade to the `unknown` face (never
throw into render), add the doctor check, and consider a small PATH augmentation in the plugin
bootstrap. On-device verification (a real deck + an authed `gh`) is required — same as item G.

## Definition of done

- Pure `classifyChecks` / `worstCi` / `ciFace` unit-tested (incl. fail-closed on garbage JSON);
  `readRepoCi` error→`unknown` tested with an injected `gh`.
- `pnpm -r --filter './packages/*' run check` + root `pnpm check` green; `streamdeck validate`
  passes; bundle builds.
- SPEC.md + README.md updated. No new deps; no afterburner import; no root `ci.yml` change.
- On-device: verify spinner/green/red + flash against a real open PR.
