import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import streamDeck from '@elgato/streamdeck';
import { autoWireHooks } from './auto-setup';
import { board } from './state';
import { forgetPainted } from './paint';
import { permissions } from './permissions';
import { config } from './config';
import { readConfigFile } from './projects-config';
import { resolvedPort, startHookServer, type HookServerHandlers } from './server';
import { isListenerBound, setListenerBound } from './listener-status';
import { ensureToken, isAuthorized } from './listener-token';
import { discoverClaudeSessions } from './discover';
import { doorbell } from './doorbell';
import { ACTION_UUIDS } from './action-uuids';
import {
  attentionKey,
  fleetDialKey,
  fleetKey,
  interruptAllKey,
  micMuteKey,
  permissionKey,
  projectKey,
  registry,
  settingsKey,
  slotKey,
  usageKey,
} from './action-registry';
import {
  bindWithRetry,
  coalesce,
  createHookGate,
  createTokenSource,
  flushOnExit,
  handleHookPayload,
  replaySpool,
} from './plugin-wiring';
import { takeSpool } from '@pimmesz/jetstream-status';

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

// One instance per action uuid (action-registry.ts, where a test checks the pairing).
for (const uuid of ACTION_UUIDS) streamDeck.actions.registerAction(registry[uuid]);

// Each doorbell flash frame (and a snooze) repaints both doorbell key types.
doorbell.onFrame = () => {
  void attentionKey.renderAll();
  void slotKey.renderKind('attention');
};

// Seed the board + settings from the optional projects.json BEFORE anything subscribes or
// connects: the Fleet roll-up and Attention doorbell then cover the whole fleet without a
// placed key per repo, and a fresh install can pin theme/timings. Placed Project keys still
// override/add by id, and a live global-settings edit still wins over the file preset.
const configFile = readConfigFile();
board.seed(configFile.projects);
// Restore the last board across an app/plugin restart, reconciled against actually-running
// sessions — a still-running session re-shows its status instead of the deck blanking to gray.
// Spool replays wait until it settles: an event replayed during its scan would race the checkpoint merge.
let hasRestored = false;
const restored = board.restore().finally(() => {
  hasRestored = true;
});
config.setBase(configFile.settings);

function renderBoard(): void {
  void projectKey.renderAll();
  void attentionKey.renderAll();
  void slotKey.renderKind('attention'); // the doorbell folded as a slot kind
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
  void slotKey.refreshUsage();
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
const scheduleBoardRender = coalesce(renderBoard, 100);

board.subscribe(scheduleBoardRender);
permissions.subscribe(() => {
  void permissionKey.renderAll();
  scheduleBoardRender(); // a pending permission also reads as "needs you" on the board
});
// A theme / settings change repaints every key.
config.subscribe(renderAll);

// Elapsed-time tick for working keys; usage refresh on its configured cadence.
setInterval(renderBoard, 30_000).unref();
/** Both usage gauges: the standalone Claude key and the usage slots (Claude or Codex). */
const refreshUsage = (): void => {
  void usageKey.refresh();
  void slotKey.refreshUsage();
};
let usageTimer = setInterval(refreshUsage, config.get().usageRefreshSec * 1000);
usageTimer.unref();
config.subscribe(() => {
  clearInterval(usageTimer);
  usageTimer = setInterval(refreshUsage, config.get().usageRefreshSec * 1000);
  usageTimer.unref();
});


// After the machine sleeps, the interval timers pause/drift — so the moment it wakes, refresh
// everything now instead of waiting up to a full poll cycle (a usage window may have reset, CI
// may have moved, the elapsed timers are stale). Cheap: each refresh no-ops when its key is unplaced.
streamDeck.system.onSystemDidWakeUp(() => {
  renderBoard();
  void usageKey.refresh();
  void slotKey.refreshUsage();
});

// First-launch onboarding: wire the status + permission hooks ourselves so installing the
// plugin is enough to make the board light up — no terminal `jetstream setup` with a
// hand-resolved plugin path. Truly first-launch (a config-dir marker makes a later manual
// hook removal stick), idempotent, and non-fatal (see autoWireHooks); fire-and-forget so
// it never delays boot. binDir is this file's own dir (bin/), where the hook scripts sit.
void autoWireHooks({ binDir: dirname(fileURLToPath(import.meta.url)), logger: streamDeck.logger });

// The loopback port must match the hook scripts (separate processes): env or default.
const port = resolvedPort();

// The shared secret the hooks and the CLI authenticate with. Generated here on first run because
// the plugin is the one component guaranteed to start; a hook only ever reads it. If the file
// cannot be written (read-only home, odd permissions) we carry on WITHOUT a token rather than
// leaving the board dark — an unauthenticated listener is the status quo, a dead one is a regression.
// Retried, NOT resolved once at boot. A listener holding no token serves everything (see
// isAuthorized — refusing would protect nothing and only darken the board), so pinning a startup
// failure for the whole process lifetime would turn a transient hiccup — a full disk at login,
// a home directory not yet mounted — into "authentication off until you restart Stream Deck".
// Re-attempt at most once a minute so the window closes on its own the moment writing works.
const currentToken = createTokenSource(() => ensureToken(), {
  onFirstFailure: (error) =>
    streamDeck.logger.warn('Jetstream could not write its listener token; staying unauthenticated and retrying', error),
});
currentToken(); // create it now so `jetstream doctor` and the hooks can see it immediately
// Log the first untokened request only — logging every hook event would drown the log. This fires
// BEFORE the accept/refuse decision and for two very different causes: a hook older than the token,
// or this plugin holding no token at all (an unwritable home). So the line must not assert either
// one, and must not claim the request was accepted — under enforcement only /hook still is.
let loggedLegacy = false;
const noteLegacyRequest = (): void => {
  if (loggedLegacy) return;
  loggedLegacy = true;
  streamDeck.logger.warn(
    'Jetstream saw an untokened loopback request — either a hook older than the token (run `jetstream hooks install`) or no token on this machine (run `jetstream doctor`). Status events still paint; permission answers and board edits are refused.',
  );
};

/** The board side of one hook event, shared by the live /hook route and the spool replay. */
const hookPayloadDeps = {
  now: Date.now,
  notePid: (sessionId: string, pid: number, cwd: string) => board.notePid(sessionId, pid, cwd),
  forgetSession: (sessionId: string) => permissions.forgetSession(sessionId),
  dispatch: (event: Parameters<typeof board.dispatch>[0]) => board.dispatch(event),
};

// Live /hook events wait until the restore and the first spool replay are done, so a spooled (older)
// event cannot land after a live (newer) one, which would break subagent start/stop pairs.
const liveHooks = createHookGate((raw, at) => handleHookPayload(raw, { ...hookPayloadDeps, now: () => at }), {
  onError: (error) => hookHandlers.onError?.('hook', error),
});

const hookHandlers: HookServerHandlers = {
  authorize: (headers, endpoint) =>
    // /hook is untokened by design, so only an untokened permission answer or key edit is worth a warning.
    isAuthorized(headers, currentToken(), endpoint === 'sensitive' ? noteLegacyRequest : undefined, endpoint),
  permissionKey: () => currentToken(),
  onPayload: (raw) => liveHooks.accept(raw),
  onPermission: (raw, abort) => permissions.request(raw, undefined, abort),
  // Live board edits from `jetstream chat`: retarget the slot at a coordinate (setSettings + repaint),
  // so a layout change lands on the deck instantly with no profile re-import.
  onSlot: (raw) => slotKey.assign(raw),
  onError: (endpoint, error) =>
    streamDeck.logger.error(`Jetstream ${endpoint} handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
};

/** Replay hook events spooled while no plugin was listening. Runs after the port binds and on every
 * poll (a hook that was refused just before the bind may append after the first drain), and only once
 * restore() has settled. */
function drainSpool(): void {
  if (!hasRestored || !isListenerBound()) return;
  replaySpool(takeSpool(), {
    ...hookPayloadDeps,
    firedAt: (sessionId) => board.firedAt(sessionId),
    onError: (error) => hookHandlers.onError?.('spool replay', error),
  });
}

// Bind with retries: an orphaned prior plugin process (the kill→respawn hazard) can still hold the
// port, and giving up early would leave the board permanently dark — no hook event ever arrives.
// The predecessor now unrefs its server + timers so it exits as soon as its handles drain, but a
// held /permission request (up to ~90s) or an in-flight poll can delay that, so keep retrying at a
// steady 1s for ~90s to outlast the worst case rather than a 4s window. Record the outcome so the
// Fleet key can surface "hooks offline".
void bindWithRetry(() => startHookServer(port, hookHandlers)).then((result) => {
  setListenerBound(result.bound);
  // Events the hooks spooled while no plugin was listening (a restart): replay them once the restore has
  // settled, so a turn that ended meanwhile does not stay "working". Live events are no longer spooled;
  // the ones that arrived meanwhile apply after the replay.
  if (result.bound) {
    void restored.then(() => {
      drainSpool();
      liveHooks.open();
    });
  }
  if (!result.bound) {
    streamDeck.logger.error(
      `Jetstream hook server could not bind 127.0.0.1:${port} within 90s, so project status will not update`,
      result.error,
    );
  }
});

// Global settings drive theme/thresholds. The listener catches future edits; the
// initial read must come AFTER connect() (it's a command over the Stream Deck socket).
streamDeck.settings.onDidReceiveGlobalSettings((ev) => config.set(ev.settings));
await streamDeck.connect();
config.set(await streamDeck.settings.getGlobalSettings());
renderAll();

/** A scan (ps + lsof, up to ~8 s) can outlast the 5 s tick; an overlapping older scan would roll the
 * board back to a stale process list, so a tick that finds one running is skipped. */
let isPolling = false;
// Discover running Claude sessions by process scan every few seconds, so a project with a
// live session shows as active even when its hook events predate this plugin instance (a
// restart, or a session sitting mid-long-operation and not firing a fresh event). Hooks stay
// authoritative for precise state; this only fills projects the hooks are silent on.
async function pollDiscoveredSessions(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    drainSpool();
    board.setDiscovered(await discoverClaudeSessions());
    // Then drop any session a per-pid probe CONCLUSIVELY reports dead, so a killed session stops
    // pinning its last status (byProject only ever fills/upgrades) — while a `ps` that can't run
    // returns 'unknown' and never erases a live one.
    board.reapDeadSessions();
  } catch {
    /* best-effort — hooks remain the source of truth */
  } finally {
    isPolling = false;
  }
}
void pollDiscoveredSessions();
setInterval(() => void pollDiscoveredSessions(), 5000).unref();

// The board checkpoint is trailing-debounced (state.ts), so a change in the last ~250ms is only in
// memory. Flush it on the way out so the newest status survives the restart, however the plugin stops
// (a closed socket, SIGTERM, or Ctrl-C in dev). A hard SIGKILL can't be caught.
flushOnExit(() => board.flush());
