# Jetstream — Elgato Marketplace submission

There is **no publish API or CLI** for the Elgato Marketplace: submission is a manual upload
at **[maker.elgato.com](https://maker.elgato.com)** (the Maker Console), followed by an Elgato
review (typically a few days). Nothing in this repo or CI can push it. This file is the
ready-to-go submission kit.

## What's already done (in the repo)

- `manifest.json` — `Version: 1.0.0.0`, `URL` set, passes `streamdeck validate`.
- Build + pack produce the submittable file.

## Produce the plugin file

```sh
pnpm --filter '@pimmesz/jetstream' run build
pnpm --filter '@pimmesz/jetstream' run validate     # must be green
pnpm --filter '@pimmesz/jetstream' run pack          # → packages/jetstream/gg.pim.jetstream.streamDeckPlugin
```

Upload `packages/jetstream/gg.pim.jetstream.streamDeckPlugin` (~180 KB) in the Console.
(It's gitignored — regenerate any time; never commit it.)

## Listing copy (paste into the Maker Console)

**Name:** Jetstream

**Subtitle / tagline:**
Claude Code, live on your Stream Deck — status board, doorbell, usage, and launch keys.

**Category:** Productivity _(pick from the Console list; Productivity is the closest fit.)_

**Tags / keywords:** claude, claude code, ai, coding, developer, productivity, status, agent,
automation, git, pull request, usage, monitoring

**Description:**

> **Jetstream turns your Stream Deck into a live cockpit for Claude Code.**
>
> Every project you're running Claude in becomes a key that glows with its real status —
> **working**, **needs you**, or **done** — so one glance answers "is anything waiting on me?"
> without alt-tabbing. When Claude asks for permission, a doorbell key lights up; approve or
> deny from the deck. A usage gauge shows your live 5-hour and 7-day subscription burn. Launch
> keys fire preset headless prompts. A fleet roll-up covers every repo at once, even ones
> without a dedicated key.
>
> **Set up in seconds, no terminal required.** Installing the plugin wires the Claude hooks
> itself; the Settings inspector walks you through adding your repos, building a personalized
> layout, and a one-press health check. Prefer the keyboard? A bundled CLI (`init`, `chat`,
> `doctor`) and a conversational setup are one command away.
>
> **Stream Deck +:** a dial scrubs your whole fleet on the touchscreen. **Two-page layouts**
> put a status Board and a controls page (model toggle, stop-all, review queue) a tap apart.
>
> Works with Claude Code standalone, and pairs with afterburner (https://afterburner.run) to
> monitor and fire automated pull-request runs from your deck.
>
> **Highlights**
> - Live per-project status board (working / needs you / done)
> - Attention doorbell + deck approve/deny for permission prompts
> - 5h / 7d subscription usage gauge
> - Preset headless launch keys + a fleet roll-up
> - Stream Deck + dial (fleet scrubber) and two-page Board/Ops layouts
> - Terminal-free setup: auto-wire + in-app fleet editor + Build-my-layout

## Assets — generated in `marketing/` (regenerate with `node scripts/gen-store-assets.mjs`)

`scripts/gen-store-assets.mjs` composes the plugin's real key faces + brand into on-brand
PNGs via headless Chrome (macOS, no deps). It writes:

| File | Size | Use |
|---|---|---|
| `marketing/thumbnail.png` | 1280×1280 | listing thumbnail / card |
| `marketing/gallery-1-board.png` | 1920×1080 | gallery — the status board |
| `marketing/gallery-2-controls.png` | 1920×1080 | gallery — the Ops/controls page |
| `marketing/gallery-3-hero.png` | 1920×1080 | gallery — hero + feature line |

Upload these in the Console (it shows the exact accepted sizes and will resize/crop). Tweak the
mockup states or copy by editing the script and re-running. **Optional upgrade:** a real photo of
your physical deck with the keys lit makes a great *additional* gallery shot — synthetic mockups
sell the concept, a real deck sells that it's real.

## Submission steps

1. Sign in at **maker.elgato.com** with your Elgato account (create the developer/maker profile if new).
2. **New product → Stream Deck plugin.** UUID must match the manifest: `gg.pim.jetstream`.
3. Fill the listing from the copy above (name, subtitle, category, tags, description).
4. Upload the assets (icon, marquee, screenshots) and the `.streamDeckPlugin` file.
5. Submit for review. Elgato reviews manually (days); they may request changes.
6. Once approved it's live with an **Install** button + **auto-updates** for users.

## Release notes (paste into the Console's notes field per version)

### v1.0.0 — first release
Jetstream turns your Stream Deck into a live cockpit for Claude Code.
- Live status board — every project glows with its real state: working, needs you, done.
- Attention doorbell + deck approve/deny for Claude permission prompts.
- Usage gauge — live 5h / 7d subscription burn, plus model + context window.
- Launch keys — fire preset headless prompts in a project with one press.
- Fleet roll-up — one key summarizing every repo, colored by the worst state present.
- Stream Deck + — a dial scrubs your whole fleet on the touchscreen.
- Two-page deck — a status Board and a controls page (model / stop-all / review / heartbeat).
- No-terminal setup — auto-wired hooks + an in-app fleet editor, health check, and layout
  builder; a bundled CLI and conversational `chat` setup for keyboard folks.
Works with Claude Code standalone; pairs with Afterburner. macOS.

Future versions: list ONLY what changed since the last release, e.g.
> ### v1.0.1
> - Fix: … · New: … · Changed: …

## Shipping updates later

Each update is a **new upload of a higher-`Version` `.streamDeckPlugin`** through the same
Console, re-reviewed. Bump `manifest.json`'s `Version` (4-part, e.g. `1.0.1.0`), rebuild, pack,
upload. There is no automated release path — the Marketplace is manual by design.

## Pre-submit checklist

- [x] `streamdeck validate` green
- [x] `Version` ≥ `1.0.0.0`, `URL` set
- [x] packed `.streamDeckPlugin` produced
- [ ] listing icon, marquee, 2–5 screenshots produced (real imagery)
- [ ] Maker account + product created, UUID `gg.pim.jetstream`
- [ ] listing copy pasted, assets + plugin uploaded
- [ ] submitted for review

**Platform:** the manifest is scoped to **macOS only** (`manifest.OS` = `mac`). The code has
Windows paths (profile open via `explorer`, `.cmd` CLI resolution) but they're not
hardware-tested, so Windows is deliberately excluded to avoid a review rejection for a
Windows-only bug. To add it back once verified on Windows: append a second `OS` entry
(`{ "Platform": "windows", "MinimumVersion": "10" }`), re-validate, bump `Version`, re-pack.
