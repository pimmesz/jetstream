import { action, SingletonAction } from '@elgato/streamdeck';
import { board } from '../state';
import { config } from '../config';
import { keyFace } from '../render';
import { ciFace, uniquePaths, pollFleetCi, isNewFailure, type CiState } from '../ci-status';

/** How often the CI key re-polls `gh`. A constant, kept slow enough not to hammer the API. */
export const CI_REFRESH_MS = 60_000;

/**
 * One always-visible key showing CI health across the fleet's open pull requests
 * (green / red / running), with a one-time flash when CI newly goes red. Polls `gh` on a
 * timer (driven by plugin.ts) and when it appears; read-only. Degrades to an "unknown"
 * face when gh is unavailable (see `jetstream doctor`). The roll-up / dedup / flash logic
 * lives in `ci-status.ts` (tested); this class is thin Stream Deck glue.
 */
@action({ UUID: 'gg.pim.jetstream.ci' })
export class CiKey extends SingletonAction {
  private state: CiState = 'none';
  private seq = 0;

  override onWillAppear(): void {
    void this.refresh();
  }

  /** Poll the fleet's open afterburner PRs and roll up the worst CI state. No-ops (no `gh`)
   * when no CI key is placed; a monotonic seq drops a stale poll that resolves after a newer
   * one, so an older slow poll can't clobber fresh state or double-flash. */
  async refresh(): Promise<void> {
    if (!this.hasKey()) return;
    const seq = ++this.seq;
    const next = await pollFleetCi(uniquePaths(board.projects()), config.get().ciBranchPrefix);
    if (seq !== this.seq) return; // a newer refresh started while awaiting — drop this stale result
    const flash = isNewFailure(this.state, next);
    this.state = next;
    await this.renderAll();
    if (flash) await this.flash();
  }

  /** Repaint the last polled state (e.g. on a theme change) without re-polling. */
  async renderAll(): Promise<void> {
    const face = ciFace(this.state);
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(
        keyFace({
          color: face.color,
          ...(face.glyph ? { glyph: face.glyph } : {}),
          label: face.label,
          sub: face.sub,
        }),
      );
    }
  }

  private hasKey(): boolean {
    return [...this.actions].some((a) => a.isKey());
  }

  private async flash(): Promise<void> {
    for (const visible of this.actions) {
      if (visible.isKey()) await visible.showAlert(); // one-time flash on a new failure
    }
  }
}
