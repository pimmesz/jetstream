import { basename } from 'node:path';
import { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { colorFor, glyphFor, type ProjectStatus } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { permissions } from '../permissions';
import { formatDiffStat, readDiffStat, type DiffStat } from '../diffstat';
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
  private pressAt = new Map<string, number>();

  override onKeyDown(ev: KeyDownEvent<ProjectSettings>): void {
    this.pressAt.set(ev.action.id, Date.now());
  }

  override async onKeyUp(ev: KeyUpEvent<ProjectSettings>): Promise<void> {
    const started = this.pressAt.get(ev.action.id);
    this.pressAt.delete(ev.action.id);
    const held = started === undefined ? 0 : Date.now() - started;

    if (held >= config.get().longPressMs) {
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
    // A settings change may re-point this key at a different repo — drop the cached badge
    // so a stale one can't stick. Leave diffPending alone: an in-flight read self-drops via
    // the path-check on resolve, so clearing it here would only spawn a duplicate `git`.
    this.diffStats.delete(actionId);
    board.setProject(actionId, { name, path });
  }

  // A: per-project done-diff, fetched ONCE per done-episode (git read is off the render
  // path, fired async on the transition and cached; cleared when a project leaves 'done').
  private diffStats = new Map<string, DiffStat | null>();
  private diffPending = new Set<string>();

  /** Redraw every visible project key from the board (called on state changes and
   * on the elapsed-timer tick). */
  async renderAll(now = Date.now()): Promise<void> {
    const theme = config.get().theme;
    const byProject = board.byProject();
    // C: which needsInput projects have a HELD permission the deck can actually answer.
    const answerable = permissions.projectsWithPending(board.projects());
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const project = board.project(visible.id);
      const state = byProject[visible.id] ?? { status: 'none' as const };
      const configured = Boolean(project?.path);
      this.trackDiff(visible.id, state.status, project?.path);
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: configured ? colorFor(state.status, theme) : '#26262b',
          label: project?.name ?? 'project',
          subMax: 20, // room for the diff badge (`+120/-40 · done 4m`)
          ...(configured ? { glyph: this.glyph(visible.id, state.status, answerable) } : {}),
          ...(configured ? this.subLine(visible.id, state, now, answerable) : { sub: 'set path' }),
        }),
      );
    }
  }

  /** A: fetch the done-diff once, off the hot render path — async + cached, cleared when
   * the project leaves 'done'. readDiffStat never throws (null on any failure). */
  private trackDiff(id: string, status: ProjectStatus, path: string | undefined): void {
    if (status !== 'done') {
      this.diffStats.delete(id);
      this.diffPending.delete(id);
      return;
    }
    if (!path || this.diffStats.has(id) || this.diffPending.has(id)) return;
    this.diffPending.add(id);
    void readDiffStat(path).then((stat) => {
      this.diffPending.delete(id);
      // Drop a result for a path the key no longer points at (re-pointed mid-read).
      if (board.project(id)?.path !== path) return;
      this.diffStats.set(id, stat);
      void this.renderAll(); // repaint now that the badge is known (cache stops a re-fetch)
    });
  }

  /** C: a needsInput project the deck CAN answer (a held permission) shows `!`; one it
   * can't (an open elicitation → go to the keyboard) shows `?`. Otherwise the status glyph. */
  private glyph(id: string, status: ProjectStatus, answerable: Set<string>): string {
    if (status === 'needsInput') return answerable.has(id) ? '!' : '?';
    return glyphFor(status);
  }

  /** The line under the label: `Bash · 12m` (working), `+120/-40 · done 4m` (finished, with
   * the change size), `approve?`/`answer` (needs you — deck-answerable or not), or the word. */
  private subLine(
    id: string,
    state: { status: ProjectStatus; since?: number; tool?: string },
    now: number,
    answerable: Set<string>,
  ): { sub: string } | Record<string, never> {
    if (state.status === 'needsInput') return { sub: answerable.has(id) ? 'approve?' : 'answer' };
    const elapsed = state.since !== undefined ? formatElapsed(now - state.since) : '';
    if (state.status === 'working' && elapsed) {
      return { sub: state.tool ? `${state.tool} · ${elapsed}` : `working ${elapsed}` };
    }
    if (state.status === 'done' && elapsed) {
      const badge = formatDiffStat(this.diffStats.get(id) ?? null);
      return { sub: badge ? `${badge} · done ${elapsed}` : `done ${elapsed}` };
    }
    const label = STATUS_LABEL[state.status] ?? '';
    return label ? { sub: label } : {};
  }
}
