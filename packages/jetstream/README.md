# Jetstream

_Full Claude control on your Elgato Stream Deck._ One key per project, glowing with that
project's live Claude Code status — red working, amber needs-you, green done — plus an
attention doorbell, usage gauges, and preset headless launches. See [SPEC.md](./SPEC.md).

## Install (two parts, same machine — macOS or Windows)

1. **Claude Code**, logged in with your subscription (`claude` → `/login`). Leave
   `ANTHROPIC_API_KEY` unset: Jetstream strips it from anything it spawns so a keypress
   can never silently bill the metered API.
2. **The plugin**: double-click `gg.pim.jetstream.streamDeckPlugin` (or, later, install
   from the Elgato Marketplace). Then wire the Claude hooks once:

   ```sh
   node "<plugin folder>/bin/hooks-install.js"
   ```

   That adds Jetstream's lifecycle hook (per-project status) and — only if you have no
   statusline yet — its usage hook to `~/.claude/settings.json`, backing the file up
   first. Restart running `claude` sessions to pick them up.

Drag keys onto your deck: **Project status** (set a name + project path per key;
short-press jumps to the terminal, **long-press interrupts** the session), **Attention**,
**Usage gauge**, **Launch preset**, and **Approve / Deny** (place one of each — they answer
the oldest pending Claude permission request straight from the deck; if you don't press within
~90s, Claude falls back to its normal dialog).

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
