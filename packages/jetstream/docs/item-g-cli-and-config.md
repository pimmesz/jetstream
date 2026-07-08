# Jetstream v1.3 — Item G: terminal onboarding (CLI + config-file projects)

**Status: DESIGNED, NOT BUILT.** Items A–F of v1.3 shipped; G was deferred as the largest
piece. This is its self-contained build spec.

## Why

Today, Jetstream setup is: run the hook installer, then in the Stream Deck app drag a
**Project key for every repo** and type its name + path into each one's Property Inspector.
There is no health check and no single place to define your fleet. G brings Jetstream
closer to afterburner's "edit a config, run a command" flow.

## Critical framing (respect exactly)

- Jetstream ships via the **Elgato Marketplace, NOT npm**, so there is **no global
  `jetstream` command on PATH**. The CLI lives INSIDE the installed bundle and is invoked
  as `node "<installed .sdPlugin>/bin/jetstream.js" <cmd>` — exactly how `bin/hooks-install.js`
  is called today. Do NOT add an npm `bin` field expecting a PATH command.
- Stream Deck owns the physical **layout** and each placed key's **settings store**
  (reachable only over its WebSocket, only by the plugin process). So the CLI / a config
  file **cannot place keys or write into a key's Property Inspector**. Presets work by the
  PLUGIN reading a config file and seeding its OWN state — never by writing into Stream Deck.

## G1 — consolidate the CLI

Fold `src/bin/hooks-install-cli.ts` into one `src/bin/jetstream-cli.ts` (built to
`bin/jetstream.js`) using `node:util` `parseArgs` (no new deps), with subcommands:

- **`hooks install [--tool-detail]`** — route to the existing hooks-install logic
  unchanged. Keep `bin/hooks-install.js` as a thin alias so nothing breaks.
- **`doctor`** — READ-ONLY checks, print `✓` / `⚠` lines, **always exit 0, never auto-fix**:
  - `claude` on PATH;
  - `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` unset (warn if set — they'd bill instead
    of drawing the subscription);
  - Jetstream hooks present in `~/.claude/settings.json`;
  - `projects.json` parseable (if present).
  This is the answer to "why isn't my board lighting up?".
- **`setup`** — one-shot: run `hooks install`, create the projects config from a template
  if absent, then print the remaining manual steps (place Project keys + set paths in the
  Property Inspector). No deck packing — the bundle is already installed by the time this runs.

Unit-test the argv dispatch (unknown cmd → usage + non-zero exit) and `doctor`'s pure checks.

## G2 — config-file projects (the afterburner-parity piece)

A projects config the plugin reads at startup and **seeds the Board**, so `matchProject`,
the Attention doorbell, and the Fleet roll-up know your repos **without every one needing a
placed key**.

- Path: `$XDG_CONFIG_HOME/jetstream/projects.json`, else `~/.config/jetstream/projects.json`
  (document the Windows `%APPDATA%\jetstream\projects.json` fallback).
- Pure `parseProjectsConfig(raw): ProjectConfig[]` — validated, tolerant (bad/missing file →
  `[]`, never throw). Reuse the existing `ProjectConfig` shape:
  ```json
  { "projects": [{ "id": "falcon", "name": "Falcon", "path": "/Users/you/falcon" }] }
  ```
- **Merge:** the file is the baseline registry; a placed Project key's PI settings
  override/add **by `id`** (deck wins on conflict). Wire `board.seed(parsed)` at server
  startup, BEFORE keys register.
- **Stop-condition:** if seeding the board is non-trivial (the registry currently derives
  from placed Project keys), implement `parseProjectsConfig` + the file read + `board.seed()`
  and STOP before reworking the PI→board flow — note exactly what's left. Don't guess merge
  semantics beyond union-by-id, deck-wins.
- Unit-test `parseProjectsConfig` (valid, missing file, malformed JSON, missing fields,
  duplicate ids).

**Payoff:** the Fleet key + Attention doorbell cover your ENTIRE fleet from the file;
Project keys become *optional* focused jump-to buttons (referenced by `id`), not the only
way the plugin learns your repos.

## G3 — file-based plugin-settings override (add-on)

Today `theme` / `longPressMs` / `usageRefreshSec` / `escalateAfterSec` come only from Stream
Deck global settings (the Settings key). Optionally let the same config preset them, so a
fresh install can pin high-contrast + timings without touching the deck:

- Extend the config file (or a sibling `settings` block) → merged over `DEFAULTS` at startup,
  with Stream Deck global settings still winning at runtime (a live toggle beats a stale
  file). Pure merge, unit-tested. Keep it OPTIONAL — absent = today's behaviour.

## What G does NOT do (the honest limits)

- It does **not place keys** on your deck — Stream Deck owns layout. The most you can ship
  is a bundled default **Profile** (a fixed starter arrangement declared in the manifest)
  that Stream Deck offers to import.
- It does **not** reach into an already-placed key's Property Inspector. The config seeds the
  plugin's registry (fleet / attention / matching), not each key's stored settings.

## Definition of done

- `pnpm -r --filter './packages/*' run check` green; afterburner root `pnpm check` still green.
- New pure logic unit-tested: the CLI dispatch, `doctor`'s checks, `parseProjectsConfig`,
  the settings merge.
- Plugin bundles; `streamdeck validate` passes; `pack` produces the `.streamDeckPlugin`.
- `SPEC.md` + `README.md` updated (the CLI, `projects.json`, `doctor`).
- Commit `feat(jetstream): v1.3 item G — CLI + config-file projects`; do NOT touch
  afterburner's root `ci.yml`.

## Suggested build order

1. **G1 pure** — the argv dispatch + `doctor` checks (fully gate-testable, no deck).
2. **G2 pure** — `parseProjectsConfig` + tests.
3. **G2 wiring** — file read + `board.seed()` at startup, up to the stop-condition.
4. **G3** — the optional settings merge.
5. **On-device** — `streamdeck validate`, install, verify the seeded fleet/attention on a
   real deck.
