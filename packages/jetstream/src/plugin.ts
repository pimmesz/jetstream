import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import streamDeck from '@elgato/streamdeck';
import { parseHookPayload } from '@pimmesz/jetstream-status';
import { autoWireHooks } from './auto-setup';
import { board } from './state';
import { permissions } from './permissions';
import { config } from './config';
import { readConfigFile } from './projects-config';
import { DEFAULT_PORT, startHookServer } from './server';
import { ProjectKey } from './actions/project';
import { AttentionKey } from './actions/attention';
import { FleetKey } from './actions/fleet';
import { UsageKey } from './actions/usage';
import { CiKey, CI_REFRESH_MS } from './actions/ci';
import { LaunchKey } from './actions/launch';
import { PermissionKey } from './actions/permission';
import { SettingsKey } from './actions/settings';

const projectKey = new ProjectKey();
const attentionKey = new AttentionKey();
const fleetKey = new FleetKey();
const usageKey = new UsageKey();
const ciKey = new CiKey();
const launchKey = new LaunchKey();
const permissionKey = new PermissionKey();
const settingsKey = new SettingsKey();

streamDeck.actions.registerAction(projectKey);
streamDeck.actions.registerAction(attentionKey);
streamDeck.actions.registerAction(fleetKey);
streamDeck.actions.registerAction(usageKey);
streamDeck.actions.registerAction(ciKey);
streamDeck.actions.registerAction(launchKey);
streamDeck.actions.registerAction(permissionKey);
streamDeck.actions.registerAction(settingsKey);

// Seed the board + settings from the optional projects.json BEFORE anything subscribes or
// connects: the Fleet roll-up and Attention doorbell then cover the whole fleet without a
// placed key per repo, and a fresh install can pin theme/timings. Placed Project keys still
// override/add by id, and a live global-settings edit still wins over the file preset.
const configFile = readConfigFile();
board.seed(configFile.projects);
config.setBase(configFile.settings);

function renderBoard(): void {
  void projectKey.renderAll();
  void attentionKey.renderAll();
  void fleetKey.renderAll();
}

function renderAll(): void {
  renderBoard();
  void usageKey.refresh();
  void ciKey.renderAll(); // repaint last CI state (the ci timer re-polls gh; theme change shouldn't)
  void settingsKey.renderAll();
  void permissionKey.renderAll();
}

board.subscribe(renderBoard);
permissions.subscribe(() => {
  void permissionKey.renderAll();
  renderBoard(); // a pending permission also reads as "needs you" on the board
});
// A theme / settings change repaints every key.
config.subscribe(renderAll);

// Elapsed-time tick for working keys; usage refresh on its configured cadence.
setInterval(renderBoard, 30_000);
let usageTimer = setInterval(() => void usageKey.refresh(), config.get().usageRefreshSec * 1000);
config.subscribe(() => {
  clearInterval(usageTimer);
  usageTimer = setInterval(() => void usageKey.refresh(), config.get().usageRefreshSec * 1000);
});

// CI/PR status polls gh on a fixed cadence; refresh() no-ops when no CI key is placed.
setInterval(() => void ciKey.refresh(), CI_REFRESH_MS);

function pidOf(raw: unknown): number | undefined {
  const pid = (raw as { _pid?: unknown })?._pid;
  return typeof pid === 'number' ? pid : undefined;
}

// First-launch onboarding: wire the status + permission hooks ourselves so installing the
// plugin is enough to make the board light up — no terminal `jetstream setup` with a
// hand-resolved plugin path. Truly first-launch (a config-dir marker makes a later manual
// hook removal stick), idempotent, and non-fatal (see autoWireHooks); fire-and-forget so
// it never delays boot. binDir is this file's own dir (bin/), where the hook scripts sit.
void autoWireHooks({ binDir: dirname(fileURLToPath(import.meta.url)), logger: streamDeck.logger });

// The loopback port must match the hook scripts (separate processes): env or default.
const port = Number(process.env.JETSTREAM_PORT) || DEFAULT_PORT;
startHookServer(port, {
  onPayload: (raw) => {
    const event = parseHookPayload(raw, Date.now());
    if (!event) return;
    const pid = pidOf(raw);
    if (pid !== undefined) board.notePid(event.sessionId, pid, event.cwd);
    board.dispatch(event);
  },
  onPermission: (raw) => permissions.request(raw),
}).catch((error: unknown) => {
  streamDeck.logger.error(
    `Jetstream hook server failed to bind 127.0.0.1:${port} — project status will not update`,
    error,
  );
});

// Global settings drive theme/thresholds. The listener catches future edits; the
// initial read must come AFTER connect() (it's a command over the Stream Deck socket).
streamDeck.settings.onDidReceiveGlobalSettings((ev) => config.set(ev.settings));
await streamDeck.connect();
config.set(await streamDeck.settings.getGlobalSettings());
renderAll();
