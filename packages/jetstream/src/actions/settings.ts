import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { board } from '../state';
import { config, type JetstreamConfig } from '../config';
import { commandOnPath, defaultDoctorIO, runDoctor } from '../doctor';
import { expandHome, handleFleetMessage, scanForGitRepos, writeFleetFile } from '../fleet';
import { hookCommands } from '../cli';
import { installHooks } from '../hooks-install';
import { profileForDeviceType } from '../profile';
import { readConfigFile, projectsConfigPath } from '../projects-config';
import { keyFace } from '../render';

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Was this a health-check request from the property inspector? */
function isHealthCheck(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { health?: unknown }).health === 'check';
}

/** "Switch to Jetstream layout" pressed in the property inspector? */
function isProfileSwitch(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { profile?: unknown }).profile === 'switch';
}

/** "Enable per-tool detail" pressed in the property inspector? */
function isToolDetail(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { hooks?: unknown }).hooks === 'toolDetail';
}

/** Doctor IO for the IN-PLUGIN health check. Stream Deck launches the plugin from the GUI
 * with the bare launchd PATH (/usr/bin:/bin:…), NOT the user's shell PATH — so a raw
 * commandOnPath('claude') would falsely report "not found" for a claude in ~/.local/bin
 * or a gh in /opt/homebrew/bin. Probe the standard CLI install dirs too so the check
 * doesn't fire false warnings that bury the real one. (The CLI `doctor` keeps the real
 * shell PATH and is unchanged.) */
function pluginDoctorIO(): ReturnType<typeof defaultDoctorIO> {
  const base = defaultDoctorIO();
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const PATH = [base.env.PATH, ...extra].filter(Boolean).join(delimiter);
  const env = { ...base.env, PATH };
  return {
    ...base,
    env,
    claudeOnPath: () => commandOnPath('claude', env),
    ghOnPath: () => commandOnPath('gh', env),
  };
}

/**
 * The settings key: shows the current theme; a press quick-toggles colour-blind
 * (high-contrast) mode. Its property inspector edits the full plugin config (theme,
 * long-press, refresh, escalate) via Stream Deck global settings, AND manages the fleet
 * (projects.json) — the terminal-free equivalent of `jetstream init`'s fleet step. The
 * inspector can't touch the filesystem (sandboxed webview), so it sends fleet messages
 * here and this backend performs the read/write + live board re-seed.
 */
@action({ UUID: 'gg.pim.jetstream.settings' })
export class SettingsKey extends SingletonAction {
  override onWillAppear(): void {
    void this.renderAll();
  }

  /** Fleet management from the property inspector: list / add / remove / scan. Delegates
   * to the shared, tested handler (fleet.ts) so the in-app and CLI paths share one rule
   * set; the file write re-seeds the board so an edit repaints Fleet/Attention live. */
  // ev is typed structurally: the SDK's SendToPluginEvent<JsonValue, T> generics resolve
  // to @elgato/utils' JSON types, which aren't a resolvable dependency here — `{ payload }`
  // is all this handler needs, and is a valid (wider) override of the optional base method.
  override async onSendToPlugin(ev: { payload: unknown }): Promise<void> {
    // Health check: the same read-only diagnostics as `jetstream doctor`, in-app, so a
    // plugin-first user whose board stays dark gets an answer without a terminal.
    if (isHealthCheck(ev.payload)) {
      this.reply({ health: 'report', checks: runDoctor(pluginDoctorIO()) });
      return;
    }
    if (isProfileSwitch(ev.payload)) {
      await this.switchProfiles();
      return;
    }
    if (isToolDetail(ev.payload)) {
      await this.enableToolDetail();
      return;
    }
    await handleFleetMessage(ev.payload, {
      read: () => readConfigFile(),
      write: (projects, settings) => writeFleetFile(projectsConfigPath(), projects, settings),
      seed: (projects) => board.seed(projects),
      // Reply to the current property inspector (the one that just sent to us).
      reply: (msg) => this.reply(msg),
      // expandHome so a typed `~/dev` resolves — the PI has no cwd/shell to expand it.
      scan: (dir) => scanForGitRepos(expandHome(dir)),
    });
  }

  /** Send a structured message back to the property inspector that messaged us. */
  private reply(msg: object): void {
    streamDeck.ui.sendToPropertyInspector(
      msg as Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0],
    );
  }

  /** Switch each connected device to its bundled Jetstream profile — the only caller of
   * switchToProfile (a plugin may only switch to manifest-declared profiles). User-initiated
   * from the PI, so it respects the profiles' DontAutoSwitchWhenInstalled. Devices with no
   * bundled profile (Stream Deck +, Pedal) are reported, not switched. Never throws. */
  private async switchProfiles(): Promise<void> {
    let switched = 0;
    const skipped: string[] = [];
    const failed: string[] = [];
    // Per-device try/catch: one device rejecting must not abort the others (leaving a
    // partial switch reported as a flat error), so each is attempted independently.
    for (const device of streamDeck.devices) {
      if (!device.isConnected) continue;
      const name = profileForDeviceType(device.type);
      if (!name) {
        skipped.push(device.name || 'a device');
        continue;
      }
      try {
        await streamDeck.profiles.switchToProfile(device.id, name);
        switched += 1;
      } catch {
        failed.push(device.name || 'a device');
      }
    }
    if (switched === 0 && skipped.length === 0 && failed.length === 0) {
      this.reply({ profile: 'error', note: 'No connected Stream Deck found.' });
      return;
    }
    const parts = [`Switched ${switched} device${switched === 1 ? '' : 's'}`];
    if (skipped.length) parts.push(`no bundled layout for ${skipped.join(', ')} (drag the Fleet dial there)`);
    if (failed.length) parts.push(`couldn't switch ${failed.join(', ')}`);
    this.reply({ profile: failed.length && switched === 0 ? 'error' : 'switched', note: `${parts.join(' · ')}.` });
  }

  /** Wire the higher-overhead per-tool-detail hooks (PreToolUse/PostToolUse) into
   * ~/.claude/settings.json — the terminal-free equivalent of `hooks install --tool-detail`.
   * Add-only (like the CLI), so this enables; it doesn't toggle off. Never throws. */
  private async enableToolDetail(): Promise<void> {
    try {
      const binDir = dirname(fileURLToPath(import.meta.url)); // bundled plugin.js sits in bin/
      const result = await installHooks({ commands: hookCommands(binDir, true) });
      this.reply({
        hooks: 'installed',
        note: result.changed
          ? 'Per-tool detail enabled — restart running `claude` sessions to pick it up.'
          : 'Per-tool detail was already enabled.',
      });
    } catch (error) {
      this.reply({ hooks: 'error', note: `Couldn't enable: ${errMsg(error)}` });
    }
  }

  override async onKeyDown(): Promise<void> {
    const current = config.get();
    const next: JetstreamConfig = {
      ...current,
      theme: current.theme === 'default' ? 'highContrast' : 'default',
    };
    // Persist globally; the plugin's onDidReceiveGlobalSettings updates `config` and
    // repaints every key.
    await streamDeck.settings.setGlobalSettings(next);
  }

  async renderAll(): Promise<void> {
    const theme = config.get().theme;
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: '#3a3a3a',
          label: 'settings',
          sub: theme === 'highContrast' ? 'contrast: on' : 'contrast: off',
        }),
      );
    }
  }
}
