import { basename } from 'node:path';
import { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { colorFor } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { formatElapsed, keyFace } from '../render';
import { openProject, interruptPids } from '../switchto';

/** Per-key settings, edited in the property inspector. `path` is the project root
 * whose Claude sessions colour this key; `name` defaults to the folder name.
 * (A type alias, not an interface: aliases get the implicit index signature the
 * SDK's JsonObject settings constraint requires.) */
export type ProjectSettings = {
  name?: string;
  path?: string;
};

const STATUS_LABEL: Record<string, string> = {
  none: '',
  idle: 'idle',
  working: 'working',
  needsInput: 'NEEDS YOU',
  done: 'done',
};

@action({ UUID: 'gg.pim.jetstream.project' })
export class ProjectKey extends SingletonAction<ProjectSettings> {
  override onWillAppear(ev: WillAppearEvent<ProjectSettings>): void {
    this.register(ev.action.id, ev.payload.settings);
    void this.renderAll();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ProjectSettings>): void {
    this.register(ev.action.id, ev.payload.settings);
    void this.renderAll();
  }

  override onWillDisappear(ev: WillDisappearEvent<ProjectSettings>): void {
    board.removeProject(ev.action.id);
  }

  // Short press → jump to the project's terminal. Long press → interrupt (SIGINT)
  // the Claude session(s) running there. Measured as key-down → key-up duration.
  private static readonly LONG_PRESS_MS = 500;
  private pressAt = new Map<string, number>();

  override onKeyDown(ev: KeyDownEvent<ProjectSettings>): void {
    this.pressAt.set(ev.action.id, Date.now());
  }

  override async onKeyUp(ev: KeyUpEvent<ProjectSettings>): Promise<void> {
    const started = this.pressAt.get(ev.action.id);
    this.pressAt.delete(ev.action.id);
    const held = started === undefined ? 0 : Date.now() - started;

    if (held >= ProjectKey.LONG_PRESS_MS) {
      const sent = interruptPids(board.pidsForProject(ev.action.id));
      await (sent > 0 ? ev.action.showOk() : ev.action.showAlert());
      return;
    }

    const project = board.project(ev.action.id);
    if (!project?.path || !openProject(project.path)) await ev.action.showAlert();
  }

  private register(actionId: string, settings: ProjectSettings): void {
    const path = settings.path ?? '';
    const name = settings.name?.trim() || (path ? basename(path) : 'set path');
    board.setProject(actionId, { name, path });
  }

  /** Redraw every visible project key from the board (called on state changes and
   * on the elapsed-timer tick). */
  async renderAll(now = Date.now()): Promise<void> {
    const byProject = board.byProject();
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const project = board.project(visible.id);
      const state = byProject[visible.id] ?? { status: 'none' as const };
      const configured = Boolean(project?.path);
      const sub =
        state.status === 'working' && state.since !== undefined
          ? `working ${formatElapsed(now - state.since)}`
          : STATUS_LABEL[state.status] ?? '';
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: configured ? colorFor(state.status) : '#26262b',
          label: project?.name ?? 'project',
          ...(configured ? (sub ? { sub } : {}) : { sub: 'set path' }),
        }),
      );
    }
  }
}
