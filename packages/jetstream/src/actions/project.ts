import { basename } from 'node:path';
import { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { type ProjectStatus } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { permissions } from '../permissions';
import { readDiffStat, type DiffStat } from '../diffstat';
import { heldMs } from '../press';
import { keyFace } from '../render';
import { openProject, interruptPids } from '../switchto';
import { projectFace } from './project-face';

/** Per-key settings, edited in the property inspector. `path` is the project root
 * whose Claude sessions colour this key; `name` defaults to the folder name.
 * (A type alias, not an interface: aliases get the implicit index signature the
 * SDK's JsonObject settings constraint requires.) */
export type ProjectSettings = {
  name?: string;
  path?: string;
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
    this.clearHoldWarn(ev.action.id);
    board.removeProject(ev.action.id);
  }

  // Short press → open the project in your editor. Long press → interrupt (SIGINT) the Claude
  // session(s) there — but ONLY when the project is actually `working`, and only after a
  // deliberate hold: past the threshold the key flips to a "release to interrupt" warning so a
  // too-long "jump to project" press can be released to cancel. Measured key-down → key-up.
  private pressAt = new Map<string, number>();
  private holdWarn = new Map<string, ReturnType<typeof setTimeout>>();

  /** SIGINT kills the current turn, so interrupt needs a longer, deliberate hold than the
   * generic long-press — and the face warns before it commits. */
  private static readonly INTERRUPT_HOLD_MS = 1500;

  override onKeyDown(ev: KeyDownEvent<ProjectSettings>): void {
    this.pressAt.set(ev.action.id, Date.now());
    // Only a working session can be interrupted — arm the warning only then. Past the hold
    // threshold, flip the face so the press is visibly "about to interrupt" (still releasable).
    if (board.byProject()[ev.action.id]?.status !== 'working') return;
    this.holdWarn.set(
      ev.action.id,
      setTimeout(() => {
        // A session that Stopped during the hold must not show a lying warning — keyUp already
        // declines to interrupt a non-working session, so keep the face honest too.
        if (board.byProject()[ev.action.id]?.status !== 'working') return;
        void ev.action.setImage(
          keyFace({
            color: '#e5484d', // danger red — this press is about to SIGINT the session
            label: board.project(ev.action.id)?.name ?? 'project',
            glyph: '✕',
            sub: 'release to interrupt',
          }),
        );
      }, ProjectKey.INTERRUPT_HOLD_MS),
    );
  }

  override async onKeyUp(ev: KeyUpEvent<ProjectSettings>): Promise<void> {
    const warned = this.clearHoldWarn(ev.action.id);
    const held = heldMs(this.pressAt, ev.action.id);
    const status = board.byProject()[ev.action.id]?.status ?? 'none';

    if (shouldInterrupt(status, held, ProjectKey.INTERRUPT_HOLD_MS)) {
      const sent = interruptPids(board.pidsForProject(ev.action.id));
      await (sent > 0 ? ev.action.showOk() : ev.action.showAlert());
    } else {
      const project = board.project(ev.action.id);
      if (!project?.path || !openProject(project.path)) await ev.action.showAlert();
    }
    if (warned) void this.renderAll(); // repaint over the "release to interrupt" warning
  }

  /** Clear a key's pending interrupt-warning timer; returns whether one was armed. */
  private clearHoldWarn(actionId: string): boolean {
    const timer = this.holdWarn.get(actionId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.holdWarn.delete(actionId);
    return true;
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
      // A key mid-interrupt-hold is showing the "release to interrupt" warning — don't let a
      // routine repaint (5s discovery tick, 30s elapsed tick) wipe it. Entry lives keydown→keyup.
      if (this.holdWarn.has(visible.id)) continue;
      const project = board.project(visible.id);
      const state = byProject[visible.id] ?? { status: 'none' as const };
      this.trackDiff(visible.id, state.status, project?.path);
      await visible.setTitle('');
      await visible.setImage(
        keyFace(
          projectFace({
            name: project?.name ?? 'project',
            configured: Boolean(project?.path),
            status: state.status,
            since: state.since,
            tool: state.tool,
            answerable: answerable.has(visible.id),
            diffStat: this.diffStats.get(visible.id) ?? null,
            now,
            theme,
          }),
        ),
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
}

/** Interrupt only a genuinely-working session, and only after a deliberate hold — so a
 * mistimed "jump to project" press can never SIGINT an idle / done / waiting session. Pure. */
export function shouldInterrupt(
  status: ProjectStatus,
  held: number,
  thresholdMs: number,
): boolean {
  return status === 'working' && held >= thresholdMs;
}
