import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import streamDeck from '@elgato/streamdeck';
import { parseHookPayload } from '@pimmesz/jetstream-status';
import { autoWireHooks } from './auto-setup';
import { board } from './state';
import { forgetPainted } from './paint';
import { permissions } from './permissions';
import { config } from './config';
import { readConfigFile } from './projects-config';
import { DEFAULT_PORT, startHookServer, type HookServerHandlers } from './server';
import { setListenerBound } from './listener-status';
import { ensureToken, isAuthorized } from './listener-token';
import { discoverClaudeSessions } from './discover';
import { ProjectKey } from './actions/project';
import { AttentionKey } from './actions/attention';
import { FleetKey } from './actions/fleet';
import { UsageKey } from './actions/usage';
import { PermissionKey } from './actions/permission';
import { SettingsKey } from './actions/settings';
import { FleetDialKey } from './actions/dial';
import { InterruptAllKey } from './actions/interrupt-all';
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
const permissionKey = new PermissionKey();
const settingsKey = new SettingsKey();
const fleetDialKey = new FleetDialKey();
const interruptAllKey = new InterruptAllKey();
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
streamDeck.actions.registerAction(permissionKey);
streamDeck.actions.registerAction(settingsKey);
streamDeck.actions.registerAction(fleetDialKey);
streamDeck.actions.registerAction(interruptAllKey);
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
  void settingsKey.renderAll();
  void permissionKey.renderAll();
}

// A key that appears or disappears is BLANK on the deck, so drop its remembered face — otherwise
// the paint cache would match the face we want and skip the very repaint that fills it. One global
// pair covers every action, so no individual key has to remember this rule.
streamDeck.actions.onWillAppear((ev) => forgetPainted(ev.action.id));
streamDeck.actions.onWillDisappear((ev) => forgetPainted(ev.action.id));

/** Coalesce burst repaints. Board state can change several times in a row (a hook flurry, the
 * restore sweep, a permission settling), and each change previously repainted EVERY key. Schedule
 * one pass 100ms after the first change instead — short enough that the board still feels live,
 * long enough that a burst costs one repaint rather than N. Paired with paint.ts's image cache:
 * this cuts how OFTEN we repaint, the cache cuts what each repaint actually uploads. */
const BOARD_RENDER_DEBOUNCE_MS = 100;
let boardRenderTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleBoardRender(): void {
  if (boardRenderTimer) return; // already coalescing — the pending pass will see the latest state
  boardRenderTimer = setTimeout(() => {
    boardRenderTimer = undefined;
    renderBoard();
  }, BOARD_RENDER_DEBOUNCE_MS);
  boardRenderTimer.unref?.();
}

board.subscribe(scheduleBoardRender);
permissions.subscribe(() => {
  void permissionKey.renderAll();
  scheduleBoardRender(); // a pending permission also reads as "needs you" on the board
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


// After the machine sleeps, the interval timers pause/drift — so the moment it wakes, refresh
// everything now instead of waiting up to a full poll cycle (a usage window may have reset, CI
// may have moved, the elapsed timers are stale). Cheap: each refresh no-ops when its key is unplaced.
streamDeck.system.onSystemDidWakeUp(() => {
  renderBoard();
  void usageKey.refresh();
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

// The shared secret the hooks and the CLI authenticate with. Generated here on first run because
// the plugin is the one component guaranteed to start; a hook only ever reads it. If the file
// cannot be written (read-only home, odd permissions) we carry on WITHOUT a token rather than
// leaving the board dark — an unauthenticated listener is the status quo, a dead one is a regression.
// Retried, NOT resolved once at boot. A listener holding no token serves everything (see
// isAuthorized — refusing would protect nothing and only darken the board), so pinning a startup
// failure for the whole process lifetime would turn a transient hiccup — a full disk at login,
// a home directory not yet mounted — into "authentication off until you restart Stream Deck".
// Re-attempt at most once a minute so the window closes on its own the moment writing works.
const TOKEN_RETRY_MS = 60_000;
let listenerToken: string | undefined;
let lastTokenAttempt = 0;
let loggedTokenFailure = false;
function currentToken(): string | undefined {
  if (listenerToken) return listenerToken;
  const now = Date.now();
  if (lastTokenAttempt !== 0 && now - lastTokenAttempt < TOKEN_RETRY_MS) return undefined;
  lastTokenAttempt = now;
  try {
    listenerToken = ensureToken();
  } catch (error) {
    if (!loggedTokenFailure) {
      loggedTokenFailure = true;
      streamDeck.logger.warn(
        'Jetstream could not write its listener token — staying unauthenticated, will keep retrying',
        error,
      );
    }
  }
  return listenerToken;
}
currentToken(); // create it now so `jetstream doctor` and the hooks can see it immediately
// Log the first unauthenticated accept only. During the grace period these are expected (hooks
// from an older release); one line tells you the window is still carrying real traffic, while
// logging every hook event would drown the log.
let loggedLegacy = false;
const noteLegacyRequest = (): void => {
  if (loggedLegacy) return;
  loggedLegacy = true;
  streamDeck.logger.warn(
    'Jetstream accepted an untokened loopback request — a hook from an older release. Run `jetstream hooks install` to re-wire it.',
  );
};

const hookHandlers: HookServerHandlers = {
  authorize: (headers, endpoint) =>
    isAuthorized(headers, currentToken(), noteLegacyRequest, endpoint),
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
