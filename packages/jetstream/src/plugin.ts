import streamDeck from '@elgato/streamdeck';
import { parseHookPayload } from '@pimmesz/jetstream-status';
import { board } from './state';
import { permissions } from './permissions';
import { DEFAULT_PORT, startHookServer } from './server';
import { ProjectKey } from './actions/project';
import { AttentionKey } from './actions/attention';
import { UsageKey } from './actions/usage';
import { LaunchKey } from './actions/launch';
import { PermissionKey } from './actions/permission';

const projectKey = new ProjectKey();
const attentionKey = new AttentionKey();
const usageKey = new UsageKey();
const launchKey = new LaunchKey();
const permissionKey = new PermissionKey();

streamDeck.actions.registerAction(projectKey);
streamDeck.actions.registerAction(attentionKey);
streamDeck.actions.registerAction(usageKey);
streamDeck.actions.registerAction(launchKey);
streamDeck.actions.registerAction(permissionKey);

function renderBoard(): void {
  void projectKey.renderAll();
  void attentionKey.renderAll();
}

board.subscribe(renderBoard);
permissions.subscribe(() => {
  void permissionKey.renderAll();
  renderBoard(); // a pending permission also reads as "needs you" on the board
});

// Elapsed-time tick for working keys; usage refresh on its own slower cadence.
setInterval(renderBoard, 30_000);
setInterval(() => void usageKey.refresh(), 60_000);

function pidOf(raw: unknown): number | undefined {
  const pid = (raw as { _pid?: unknown })?._pid;
  return typeof pid === 'number' ? pid : undefined;
}

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

await streamDeck.connect();
renderBoard();
void usageKey.refresh();
