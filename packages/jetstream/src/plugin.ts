import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import streamDeck from '@elgato/streamdeck';
import { parseHookPayload } from '@pimmesz/jetstream-status';
import { autoWireHooks } from './auto-setup';
import { board } from './state';
import { permissions } from './permissions';
import { config } from './config';
import { readConfigFile } from './projects-config';
import { DEFAULT_PORT, startHookServer, type HookServerHandlers } from './server';
import { setListenerBound } from './listener-status';
import { discoverClaudeSessions } from './discover';
import { ProjectKey } from './actions/project';
import { AttentionKey } from './actions/attention';
import { FleetKey } from './actions/fleet';
import { UsageKey } from './actions/usage';
import { CiKey, CI_REFRESH_MS } from './actions/ci';
import { LaunchKey } from './actions/launch';
import { PermissionKey } from './actions/permission';
import { SettingsKey } from './actions/settings';
import { FleetDialKey } from './actions/dial';
import { InterruptAllKey } from './actions/interrupt-all';
import { ModelKey } from './actions/model';
import { HeartbeatKey } from './actions/heartbeat';
import { ReviewKey } from './actions/review';
import { NavKey } from './actions/nav';
import { BuildKey } from './actions/build';
import { CoordinateKey } from './actions/coord';
import { GridKey } from './actions/grid';
import { SlotKey } from './actions/slot';
import { MicMuteKey } from './actions/micmute';

// Resilience: a long-running Stream Deck plugin must NOT die on a transient async hiccup. The SDK
// resolves socket commands (getSettings / getGlobalSettings / switchToProfile / …) as promises that
// reject with "The request timed out" under WebSocket congestion; a background poll (CI/usage/discover)
// can reject the same way. Node's default is to treat an unhandled rejection as fatal — which was
// crash-looping the plugin and RESETTING the board (wiping any live `jetstream chat` edits) on respawn.
// Log and continue instead: one dropped repaint/poll is recoverable; a crashed board is not.
process.on('unhandledRejection', (reason) => {
  streamDeck.logger.error('Unhandled promise rejection (continuing — not crashing the plugin)', reason);
});
process.on('uncaughtException', (error) => {
  streamDeck.logger.error('Uncaught exception (continuing — not crashing the plugin)', error);
});

const projectKey = new ProjectKey();
const attentionKey = new AttentionKey();
const fleetKey = new FleetKey();
const usageKey = new UsageKey();
const ciKey = new CiKey();
const launchKey = new LaunchKey();
const permissionKey = new PermissionKey();
const settingsKey = new SettingsKey();
const fleetDialKey = new FleetDialKey();
const interruptAllKey = new InterruptAllKey();
const modelKey = new ModelKey();
const heartbeatKey = new HeartbeatKey();
const reviewKey = new ReviewKey();
const navKey = new NavKey();
const buildKey = new BuildKey();
const coordinateKey = new CoordinateKey();
const gridKey = new GridKey();
const slotKey = new SlotKey();
const micMuteKey = new MicMuteKey();

streamDeck.actions.registerAction(projectKey);
streamDeck.actions.registerAction(attentionKey);
streamDeck.actions.registerAction(fleetKey);
streamDeck.actions.registerAction(usageKey);
streamDeck.actions.registerAction(ciKey);
streamDeck.actions.registerAction(launchKey);
streamDeck.actions.registerAction(permissionKey);
streamDeck.actions.registerAction(settingsKey);
streamDeck.actions.registerAction(fleetDialKey);
streamDeck.actions.registerAction(interruptAllKey);
streamDeck.actions.registerAction(modelKey);
streamDeck.actions.registerAction(heartbeatKey);
streamDeck.actions.registerAction(reviewKey);
streamDeck.actions.registerAction(navKey);
streamDeck.actions.registerAction(buildKey);
streamDeck.actions.registerAction(coordinateKey);
streamDeck.actions.registerAction(gridKey);
streamDeck.actions.registerAction(slotKey);
streamDeck.actions.registerAction(micMuteKey);

// Seed the board + settings from the optional projects.json BEFORE anything subscribes or
// connects: the Fleet roll-up and Attention doorbell then cover the whole fleet without a
// placed key per repo, and a fresh install can pin theme/timings. Placed Project keys still
// override/add by id, and a live global-settings edit still wins over the file preset.
const configFile = readConfigFile();
board.seed(configFile.projects);
// Restore the last board across an app/plugin restart, reconciled against actually-running
// sessions — a still-running session re-shows its status instead of the deck blanking to gray.
void board.restore();
config.setBase(configFile.settings);

function renderBoard(): void {
  void projectKey.renderAll();
  void attentionKey.renderAll();
  void fleetKey.renderAll();
  void fleetDialKey.renderAll(); // Stream Deck + touchscreen; no-op when no dial is placed
  void interruptAllKey.renderAll(); // working-count face tracks the board
  void slotKey.renderKind('stopall'); // stop-all folded as a slot kind — refresh its working-count face
  void slotKey.renderKind('fleet'); // fleet roll-up folded as a slot kind — refresh on every board change
  void slotKey.renderKind('project'); // project folded as a slot kind — refresh live status/glyph/elapsed
  void micMuteKey.renderAll(); // re-read mic state so an external mute (Zoom, …) reflects on the key
}

function renderAll(): void {
  renderBoard();
  void usageKey.refresh();
  void ciKey.renderAll(); // repaint last CI state (the ci timer re-polls gh; theme change shouldn't)
  void settingsKey.renderAll();
  void permissionKey.renderAll();
  void modelKey.renderAll(); // repaint the model face on a global-settings change
  void slotKey.renderKind('model'); // model folded as a slot kind — repaint on the same change
}

board.subscribe(renderBoard);
permissions.subscribe(() => {
  void permissionKey.renderAll();
  renderBoard(); // a pending permission also reads as "needs you" on the board
});
// A theme / settings change repaints every key.
config.subscribe(renderAll);

// Elapsed-time tick for working keys; usage refresh on its configured cadence.
setInterval(renderBoard, 30_000).unref();
let usageTimer = setInterval(() => void usageKey.refresh(), config.get().usageRefreshSec * 1000);
usageTimer.unref();
config.subscribe(() => {
  clearInterval(usageTimer);
  usageTimer = setInterval(() => void usageKey.refresh(), config.get().usageRefreshSec * 1000);
  usageTimer.unref();
});

// CI/PR status polls gh on a fixed cadence; refresh() no-ops when no CI key is placed.
setInterval(() => void ciKey.refresh(), CI_REFRESH_MS).unref();

// afterburner heartbeat + review queue: poll the sibling CLI on a slow cadence. Both no-op
// (never spawn) when no such key is placed, so a board without them costs nothing.
setInterval(() => void heartbeatKey.refresh(), 60_000).unref();
setInterval(() => void reviewKey.refresh(), 120_000).unref();

// After the machine sleeps, the interval timers pause/drift — so the moment it wakes, refresh
// everything now instead of waiting up to a full poll cycle (a usage window may have reset, CI
// may have moved, the elapsed timers are stale). Cheap: each refresh no-ops when its key is unplaced.
streamDeck.system.onSystemDidWakeUp(() => {
  renderBoard();
  void usageKey.refresh();
  void ciKey.refresh();
  void heartbeatKey.refresh();
  void reviewKey.refresh();
});

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
const hookHandlers: HookServerHandlers = {
  onPayload: (raw) => {
    const event = parseHookPayload(raw, Date.now());
    if (!event) return;
    const pid = pidOf(raw);
    if (pid !== undefined) board.notePid(event.sessionId, pid, event.cwd);
    // When a session ends, drop any Always-Allow rules it armed (session-scoped, memory-only).
    if (event.event === 'SessionEnd') permissions.forgetSession(event.sessionId);
    board.dispatch(event);
  },
  onPermission: (raw) => permissions.request(raw),
  // Live board edits from `jetstream chat`: retarget the slot at a coordinate (setSettings + repaint),
  // so a layout change lands on the deck instantly with no profile re-import.
  onSlot: (raw) => slotKey.assign(raw),
};
// Bind with retries: an orphaned prior plugin process (the kill→respawn hazard) can still hold the
// port, and giving up early would leave the board permanently dark — no hook event ever arrives.
// The predecessor now unrefs its server + timers so it exits as soon as its handles drain, but a
// held /permission request (up to ~90s) or an in-flight poll can delay that, so keep retrying at a
// steady 1s for ~90s to outlast the worst case rather than a 4s window. Record the outcome so the
// Fleet key can surface "hooks offline".
void (async () => {
  const RETRY_MS = 1_000;
  const MAX_WAIT_MS = 90_000;
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      await startHookServer(port, hookHandlers);
      setListenerBound(true);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        setListenerBound(false);
        streamDeck.logger.error(
          `Jetstream hook server could not bind 127.0.0.1:${port} within ${MAX_WAIT_MS / 1000}s — project status will not update`,
          error,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
})();

// Global settings drive theme/thresholds. The listener catches future edits; the
// initial read must come AFTER connect() (it's a command over the Stream Deck socket).
streamDeck.settings.onDidReceiveGlobalSettings((ev) => config.set(ev.settings));
await streamDeck.connect();
config.set(await streamDeck.settings.getGlobalSettings());
renderAll();

// Discover running Claude sessions by process scan every few seconds, so a project with a
// live session shows as active even when its hook events predate this plugin instance (a
// restart, or a session sitting mid-long-operation and not firing a fresh event). Hooks stay
// authoritative for precise state; this only fills projects the hooks are silent on.
async function pollDiscoveredSessions(): Promise<void> {
  try {
    board.setDiscovered(await discoverClaudeSessions());
    // Then drop any session a per-pid probe CONCLUSIVELY reports dead, so a killed session stops
    // pinning its last status (byProject only ever fills/upgrades) — while a `ps` that can't run
    // returns 'unknown' and never erases a live one.
    board.reapDeadSessions();
  } catch {
    /* best-effort — hooks remain the source of truth */
  }
}
void pollDiscoveredSessions();
setInterval(() => void pollDiscoveredSessions(), 5000).unref();

// The board checkpoint is trailing-debounced (state.ts), so a change in the last ~250ms is only in
// memory. On a clean shutdown (Stream Deck terminating the plugin, or Ctrl-C in dev) flush it first so
// the newest status survives the restart. A SIGTERM/SIGINT listener overrides Node's default terminate,
// so we exit explicitly after the (synchronous, never-throwing) flush. A hard SIGKILL can't be caught.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    board.flush();
    process.exit(0);
  });
}
