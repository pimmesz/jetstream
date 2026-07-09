import { lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import { board } from '../state';
import { config, type JetstreamConfig } from '../config';
import { commandOnPath, defaultDoctorIO, runDoctor, type CheckResult } from '../doctor';
import { expandHome, handleFleetMessage, scanForGitRepos, writeFleetFile } from '../fleet';
import { hookCommands } from '../cli';
import { installHooks } from '../hooks-install';
import { defaultOpenFile } from '../open-file';
import {
  deckForDeviceType,
  defaultProfileName,
  profileForDeviceType,
  writeProfileFile,
  type DeckModel,
} from '../profile';
import { readConfigFile, projectsConfigPath } from '../projects-config';
import { keyFace } from '../render';

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Was this a health-check request from the property inspector? */
export function isHealthCheck(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { health?: unknown }).health === 'check';
}

/** "Switch to Jetstream layout" pressed in the property inspector? */
export function isProfileSwitch(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { profile?: unknown }).profile === 'switch';
}

/** "Enable per-tool detail" pressed in the property inspector? */
export function isToolDetail(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { hooks?: unknown }).hooks === 'toolDetail';
}

/** "Build my layout" pressed in the property inspector? */
export function isBuildLayout(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { build?: unknown }).build === 'layout';
}

/** "Copy diagnostics" pressed in the property inspector? */
export function isDiagnostics(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { diag?: unknown }).diag === 'copy';
}

/** A checklist "Fix" button (currently only `fix: 'hooks'`; the 'fleet' fix is client-side). */
export function fixId(payload: unknown): string | undefined {
  const fix = (payload as { fix?: unknown } | null)?.fix;
  return typeof fix === 'string' ? fix : undefined;
}

/** The bin/ dir where the bundled hook scripts sit (this file bundles into bin/plugin.js). */
function pluginBinDir(): string {
  return dirname(fileURLToPath(import.meta.url));
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
      this.reply({ health: 'report', checks: this.pluginHealth() });
      return;
    }
    if (fixId(ev.payload) === 'hooks') {
      await this.fixHooks();
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
    if (isBuildLayout(ev.payload)) {
      this.buildProfiles();
      return;
    }
    if (isDiagnostics(ev.payload)) {
      const checks = runDoctor(pluginDoctorIO());
      const text = [
        'Jetstream diagnostics',
        `platform: ${process.platform}  node: ${process.version}`,
        '',
        ...checks.map((c) => `${c.status === 'ok' ? 'OK  ' : 'WARN'} ${c.message}`),
      ].join('\n');
      this.reply({ diag: 'report', text });
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
      const result = await installHooks({ commands: hookCommands(pluginBinDir(), true) });
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

  /** "Build my layout": generate a PERSONALIZED .streamDeckProfile (fleet keys pre-filled)
   * per connected device into ~/Downloads and open each so Stream Deck's import dialog
   * appears — the terminal-free equivalent of `jetstream init`'s profile step. Additive: the
   * user picks the device in the dialog; existing layouts are never overwritten. The plugin
   * backend (Node) may write files; the sandboxed PI can't, so it delegates here. Never throws. */
  private buildProfiles(): void {
    const projects = readConfigFile().projects;
    const decks = new Map<DeckModel['key'], DeckModel>();
    for (const device of streamDeck.devices) {
      if (!device.isConnected) continue;
      const deck = deckForDeviceType(device.type);
      if (deck) decks.set(deck.key, deck); // dedupe: two identical decks share one profile
    }
    if (decks.size === 0) {
      this.reply({
        build: 'error',
        note: 'No supported Stream Deck connected — the dial-only Stream Deck + has no importable layout yet.',
      });
      return;
    }
    const written: string[] = [];
    try {
      const dir = join(homedir(), 'Downloads');
      for (const deck of decks.values()) {
        const out = join(dir, `Jetstream ${defaultProfileName(deck)}.streamDeckProfile`);
        // Never write THROUGH a pre-existing file/symlink at our own target name (writeFileSync
        // follows symlinks); remove the entry itself first, then write fresh.
        try {
          lstatSync(out);
          unlinkSync(out);
        } catch {
          // absent — nothing to remove
        }
        writeProfileFile(out, deck, projects);
        written.push(out);
      }
    } catch (error) {
      this.reply({ build: 'error', note: `Couldn't build the layout: ${errMsg(error)}` });
      return;
    }
    const open = defaultOpenFile();
    for (const file of written) open?.(file);
    const base = open
      ? `Built ${written.length} layout${written.length === 1 ? '' : 's'} in Downloads — approve the import in Stream Deck.`
      : `Built ${written.length} layout${written.length === 1 ? '' : 's'} in Downloads — double-click to import.`;
    this.reply({
      build: 'done',
      note: projects.length
        ? base
        : `${base} (Empty fleet — the layout matches the bundled default until you add repos.)`,
    });
  }

  /** The in-app setup checklist: the read-only doctor checks PLUS a fleet check. Empty fleet
   * = the board stays dark, so it belongs here even though doctor.ts stays fleet-agnostic
   * (an empty projects.json is legitimately OK for a placed-keys user, per checkProjectsConfig). */
  private pluginHealth(): CheckResult[] {
    const count = board.projects().length;
    const fleet: CheckResult =
      count > 0
        ? { status: 'ok', message: `${count} project${count === 1 ? '' : 's'} in your fleet` }
        : {
            status: 'warn',
            message: 'No projects yet — add repos so the Fleet/Attention keys light up',
            fixId: 'fleet',
          };
    return [...runDoctor(pluginDoctorIO()), fleet];
  }

  /** One-press fix for the 'hooks' checklist item: install the BASE hooks (never the
   * higher-overhead tool-detail variant), then re-run the checklist so the row flips to ✓
   * and the settings face's setup counter updates. Never throws. */
  private async fixHooks(): Promise<void> {
    try {
      await installHooks({ commands: hookCommands(pluginBinDir(), false) });
    } catch (error) {
      const checks = this.pluginHealth();
      checks.push({ status: 'warn', message: `Couldn't install hooks: ${errMsg(error)}` });
      this.reply({ health: 'report', checks });
      return;
    }
    this.reply({ health: 'report', checks: this.pluginHealth() });
    void this.renderAll();
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
    // Nudge: while setup is incomplete the face shows "setup N/M" (amber); once every check
    // passes it falls back to the contrast state. Open the inspector for the fixable list.
    const checks = this.pluginHealth();
    const warns = checks.filter((c) => c.status === 'warn').length;
    const sub =
      warns > 0
        ? `setup ${checks.length - warns}/${checks.length}`
        : theme === 'highContrast'
          ? 'contrast: on'
          : 'contrast: off';
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(
        keyFace({ color: warns > 0 ? '#b58900' : '#3a3a3a', label: 'settings', sub }),
      );
    }
  }
}
