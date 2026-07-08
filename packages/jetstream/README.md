# Jetstream

_Full Claude control on your Elgato Stream Deck._ One key per project, glowing with that
project's live Claude Code status — red working, amber needs-you, green done — plus an
attention doorbell, usage gauges, and preset headless launches. See [SPEC.md](./SPEC.md).

## Install (two parts, same machine — macOS or Windows)

1. **Claude Code**, logged in with your subscription (`claude` → `/login`). Leave
   `ANTHROPIC_API_KEY` unset: Jetstream strips it from anything it spawns so a keypress
   can never silently bill the metered API.
2. **The plugin**: double-click `gg.pim.jetstream.streamDeckPlugin` (or, later, install

   from the Elgato Marketplace). Then run the one-time setup:

   ```sh
   node "<plugin folder>/bin/jetstream.js" setup
   ```

   That wires Jetstream's lifecycle hook (per-project status) and — only if you have no
   statusline yet — its usage hook into `~/.claude/settings.json` (backing the file up
   first), then drops a starter `projects.json`. Restart running `claude` sessions to pick
   them up. Prefer the pieces? `jetstream.js hooks install` does only the hooks (the old
   `bin/hooks-install.js` still works), and `jetstream.js doctor` is a read-only health
   check for when the board isn't lighting up.

Drag keys onto your deck: **Project status** (set a name + project path per key;
short-press jumps to the terminal, **long-press interrupts** the session; done keys show the
change size, `+120/-40 · done 4m`), **Fleet roll-up** (one always-visible key counting the whole
fleet — `3w 1! 2✓` — coloured by the worst state present, so "is anything waiting on me?" is
answerable even when projects outnumber keys), **Attention** (flashes if a request goes
unanswered), **Usage gauge** (5h/7d used + the sooner reset, `resets 3h33m`), **CI / PR status** (one
always-visible key: the worst CI state across your open `afterburner/` PRs — green / red /
running — flashing when CI newly fails; needs the `gh` CLI logged in), **Launch preset**
(now usable inside Stream Deck multi-actions), **Approve / Deny** (place one of each — they answer
the oldest pending Claude permission request straight from the deck; no press within ~90s → Claude
falls back to its normal dialog), and **Jetstream settings** (press to toggle colour-blind mode;
its inspector sets escalation/long-press/refresh). Amber keys distinguish a deck-answerable prompt
(`!`, `approve?`) from an open question you must type (`?`, `answer`).

Every state also carries a **glyph** (`⋯` working, `!` needs-you, `✓` done), so the board reads
without relying on colour — and the settings key's high-contrast theme swaps the red/green pair
for orange/blue.

## Works on any Stream Deck

Nothing is device-specific — you drag as many keys as your device has (Mini 6, MK.2 15, XL 32,
Neo). There's no layout to pick; each **Project** key holds its own name+path, so everyone's board
is their own. (Stream Deck **+** dials / touch strip aren't used yet — a future item.)

## Config file (optional)

Define your whole fleet in one place instead of a placed key per repo. Jetstream reads
`$XDG_CONFIG_HOME/jetstream/projects.json` (else `~/.config/jetstream/projects.json`;
`%APPDATA%\jetstream\projects.json` on Windows) at startup:

```json
{
  "projects": [{ "id": "falcon", "name": "Falcon", "path": "/Users/you/falcon" }]
}
```

The **Fleet** roll-up and **Attention** doorbell then cover every repo in the file, so placed
**Project** keys become optional focused jump-to buttons rather than the only way the plugin learns
your repos. An optional `"settings"` block (`theme`, `longPressMs`, `usageRefreshSec`,
`escalateAfterSec`) presets the plugin config on a fresh install — the Settings key still wins at
runtime. Run `jetstream.js doctor` to check the file is parseable.

## Optional: show the active tool

Working keys can show the current tool (`Bash · 12m`) instead of just `working 12m`. It needs the
higher-overhead `PreToolUse`/`PostToolUse` hooks (a hook process per tool call), so it's opt-in:

```sh
node "<plugin folder>/bin/jetstream.js" hooks install --tool-detail
```

## Which meter does what

- The **usage gauge** shows your interactive 5h/7d subscription windows.
- **Launch preset** runs headless `claude -p`, which draws the separate Agent-SDK
  allotment — it does **not** move the 5h/7d gauge.
- Watching status costs nothing; hooks only report lifecycle events locally
  (`127.0.0.1`, never the network).

## Develop

```sh
pnpm --filter '@pimmesz/jetstream' run check    # typecheck + tests
pnpm --filter '@pimmesz/jetstream' run build    # bundle into the .sdPlugin
pnpm --filter '@pimmesz/jetstream' run validate # Elgato manifest validation
pnpm --filter '@pimmesz/jetstream' run pack     # produce the .streamDeckPlugin
```
