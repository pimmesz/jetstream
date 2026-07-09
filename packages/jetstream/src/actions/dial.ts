import { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DialAction,
  DialDownEvent,
  DialRotateEvent,
  DialUpEvent,
  TouchTapEvent,
  WillAppearEvent,
} from '@elgato/streamdeck';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import { board } from '../state';
import { config } from '../config';
import { dialFeedback, scrubIndex } from '../encoder';
import { heldMs } from '../press';
import { interruptPids, openProject } from '../switchto';

/**
 * The Fleet dial (Stream Deck + encoder): one dial to scan the whole fleet without a key
 * per repo. Rotate scrubs through the projects (wrap-around), the touchscreen shows the
 * selected project's live status, a short press / tap jumps into it, and a long press
 * interrupts its Claude session(s) — mirroring the keypad Project key's press semantics.
 * Encoder-only: the keypad board already covers non-+ decks.
 *
 * Thin by design (like every action here): the index math + touchscreen content live in
 * the tested `encoder.ts`; this file is SDK glue.
 */
@action({ UUID: 'gg.pim.jetstream.dial' })
export class FleetDialKey extends SingletonAction {
  /** Selected fleet index, per dial instance (an action can be placed more than once). */
  private index = new Map<string, number>();
  /** Press-start timestamp, per dial instance, for long-press detection. */
  private pressAt = new Map<string, number>();

  override onWillAppear(ev: WillAppearEvent): void {
    if (!this.index.has(ev.action.id)) this.index.set(ev.action.id, 0);
    void this.renderAll();
  }

  override onDialRotate(ev: DialRotateEvent): void {
    const len = board.projects().length;
    const next = scrubIndex(len, this.index.get(ev.action.id) ?? 0, ev.payload.ticks);
    this.index.set(ev.action.id, next);
    void this.renderId(ev.action.id);
  }

  override onDialDown(ev: DialDownEvent): void {
    this.pressAt.set(ev.action.id, Date.now());
  }

  override async onDialUp(ev: DialUpEvent): Promise<void> {
    const held = heldMs(this.pressAt, ev.action.id);
    const project = this.selected(ev.action.id);
    if (!project) return;

    if (held >= config.get().longPressMs) {
      const sent = interruptPids(board.pidsForProject(project.id));
      if (sent === 0) await ev.action.showAlert();
      return;
    }
    if (!project.path || !openProject(project.path)) await ev.action.showAlert();
  }

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    const project = this.selected(ev.action.id);
    if (!project) return;
    // A held touch interrupts (matches the touchscreen's LongTouch hint + the long dial-push);
    // a plain tap opens. The SDK delivers a long touch as one touchTap with hold=true.
    if (ev.payload.hold) {
      const sent = interruptPids(board.pidsForProject(project.id));
      if (sent === 0) await ev.action.showAlert();
      return;
    }
    if (!project.path || !openProject(project.path)) await ev.action.showAlert();
  }

  /** The project the given dial is currently pointing at (index clamped to the live fleet). */
  private selected(actionId: string): ProjectConfig | undefined {
    const projects = board.projects();
    if (!projects.length) return undefined;
    return projects[scrubIndex(projects.length, this.index.get(actionId) ?? 0, 0)];
  }

  /** Repaint every placed dial (called on board/theme changes and the elapsed tick). */
  async renderAll(now = Date.now()): Promise<void> {
    for (const visible of this.actions) {
      if (visible.isDial()) await this.paint(visible, now);
    }
  }

  private async renderId(actionId: string, now = Date.now()): Promise<void> {
    for (const visible of this.actions) {
      if (visible.id === actionId && visible.isDial()) await this.paint(visible, now);
    }
  }

  private async paint(dial: DialAction, now: number): Promise<void> {
    const projects = board.projects();
    const i = scrubIndex(projects.length, this.index.get(dial.id) ?? 0, 0);
    const project = projects[i];
    const state = project
      ? (board.byProject()[project.id] ?? { status: 'none' as const })
      : { status: 'none' as const };
    const fb = dialFeedback(project, state, now, config.get().theme);
    await dial.setFeedback({ title: fb.title, value: { value: fb.value, color: fb.color } });
  }
}
