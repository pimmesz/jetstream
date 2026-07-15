# @pimmesz/jetstream

_Full Claude control on your Elgato Stream Deck._

One key per project, glowing with that project's live Claude Code status — working,
needs-you, done — plus an attention doorbell, usage gauges, deck approvals, and preset
headless launches. Add app / URL / command shortcut keys, give any key a colour, emoji, or
the app's real logo, and build your whole board by talking to it (`jetstream chat`).

This package is the installer: it ships the packed Stream Deck plugin and hands it to the
Stream Deck app for you.

## Install (macOS or Windows)

```sh
npm i -g @pimmesz/jetstream
jetstream install
```

Approve the install prompt in Stream Deck. Then set up your fleet:

```sh
jetstream chat   # conversational — "3 repos in ~/dev: …", "add a Telegram key at a8"
jetstream init   # guided wizard — repos, theme/timings, a ready-made layout
```

Updating? Re-run the same two install commands.

You also need **Claude Code**, logged in with your subscription (`claude` → `/login`).
Leave `ANTHROPIC_API_KEY` unset: Jetstream strips it from anything it spawns, so a keypress
can never silently bill the metered API.

## Commands

| Command             | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `jetstream install` | Hand the packed plugin to the Stream Deck app               |
| `jetstream chat`    | Build/arrange your board by describing it in plain English  |
| `jetstream init`    | Guided setup — repos, theme, timings, a ready-made layout   |
| `jetstream setup`   | Hooks + a starter `projects.json`                           |
| `jetstream hooks`   | Wire only the Claude Code hooks                             |
| `jetstream doctor`  | Read-only health check for when the board isn't lighting up |

Everything except `install` is forwarded to the installed plugin's own CLI, so install first.

## Docs

Full documentation, key reference, and configuration:
**[github.com/pimmesz/jetstream](https://github.com/pimmesz/jetstream#readme)**

Licensed under Apache-2.0.
