import streamDeck from '@elgato/streamdeck';
import { parseHookPayload } from '@pimmesz/jetstream-status';
import { board } from './state';
import { permissions } from './permissions';
import { config } from './config';
import { DEFAULT_PORT, startHookServer } from './server';
import { ProjectKey } from './actions/project';
import { AttentionKey } from './actions/attention';
import { FleetKey } from './actions/fleet';
import { UsageKey } from './actions/usage';
import { LaunchKey } from './actions/launch';
import { PermissionKey } from './actions/permission';
import { SettingsKey } from './actions/settings';

const projectKey = new ProjectKey();
const attentionKey = new AttentionKey();
const fleetKey = new FleetKey();
const usageKey = new UsageKey();
const launchKey = new LaunchKey();
const permissionKey = new PermissionKey();
const settingsKey = new SettingsKey();

streamDeck.actions.registerAction(projectKey);
streamDeck.actions.registerAction(attentionKey);
streamDeck.actions.registerAction(fleetKey);
streamDeck.actions.registerAction(usageKey);
streamDeck.actions.registerAction(launchKey);
streamDeck.actions.registerAction(permissionKey);
streamDeck.actions.registerAction(settingsKey);

function renderBoard(): void {
  void projectKey.renderAll();
  void attentionKey.renderAll();
  void fleetKey.renderAll();
}

function renderAll(): void {
  renderBoard();
  void usageKey.refresh();
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

function pidOf(raw: unknown): number | undefined {
  const pid = (raw as { _pid?: unknown })?._pid;
  return typeof pid === 'number' ? pid : undefined;
}

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
