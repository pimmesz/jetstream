import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The subcommands a key may open a terminal for. A closed union, NOT a free string: the launcher
 * script's whole no-injection property rests on its contents being fixed at compile time. */
export type TerminalCommand = 'doctor' | 'chat';

/**
 * Open a terminal running `jetstream <command>` — `doctor` (read-only; reports the checklist and
 * prints the fix for each failing item) or `chat` (the conversational board builder, which needs a
 * real interactive TTY and so cannot run inside the plugin). Resolves true only once the launcher
 * actually spawned; false where no terminal exists or launching failed, so the caller can alert
 * instead of a false OK. Stream Deck itself runs only on macOS + Windows, so the `false` tail is
 * defensive.
 *
 * The launcher is a fixed-content script (the command comes from the union above, never from user
 * input → no injection) written into a FRESH private `mkdtemp` dir, so a predictable name in a
 * shared temp can't be pre-planted as a symlink and clobbered/replaced between write and exec.
 * (One dir per launch and no cleanup, which is fine: these fire a handful of times by hand, and
 * the OS reaps temp.) A real terminal re-derives the user's PATH — macOS Terminal opens a login
 * shell; the Windows launcher prepends the npm global bin — so the globally installed `jetstream`
 * resolves even though the plugin's own GUI-launched PATH is stripped.
 */
export function openInTerminal(command: TerminalCommand): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // A short timeout guarantees the promise settles even if the launcher never returns, so a
      // press always ends in OK/alert. `open` / `start` normally exit in well under a second.
      const opts = { timeout: 10_000 } as const;
      if (process.platform === 'darwin') {
        const file = join(mkdtempSync(join(tmpdir(), `jetstream-${command}-`)), `${command}.command`);
        // Run the command, then drop into an interactive shell so the window stays open and you can
        // type a follow-up (`jetstream update`, `jetstream setup`, …) right there.
        writeFileSync(file, `#!/bin/bash\njetstream ${command}\nexec "$SHELL" -i\n`);
        chmodSync(file, 0o755);
        execFile('open', [file], opts, (err) => resolve(!err));
        return;
      }
      if (process.platform === 'win32') {
        const dir = mkdtempSync(join(tmpdir(), `jetstream-${command}-`));
        // Prepend the default npm global bin so a normally-installed `jetstream.cmd` resolves — the
        // new cmd inherits the plugin's (possibly stripped) env, not a fresh login shell.
        writeFileSync(
          join(dir, `${command}.cmd`),
          `@echo off\r\nset "PATH=%APPDATA%\\npm;%PATH%"\r\njetstream ${command}\r\n`,
        );
        // Run FROM `dir` and hand cmd only the bare basename: a temp path with a cmd metacharacter
        // (e.g. TEMP=C:\Temp&Work) would otherwise be re-parsed by cmd.exe. `cmd /k` runs the script
        // then keeps the window at an interactive prompt.
        execFile('cmd', ['/c', 'start', '', 'cmd', '/k', `${command}.cmd`], { ...opts, cwd: dir }, (err) =>
          resolve(!err),
        );
        return;
      }
      resolve(false);
    } catch {
      // Creating the launcher failed (read-only temp, disk full) — resolve false so the caller
      // shows an alert rather than letting a keypress reject.
      resolve(false);
    }
  });
}

/** Back-compat alias for the Settings key's incomplete-setup press. */
export const openDoctorInTerminal = (): Promise<boolean> => openInTerminal('doctor');
