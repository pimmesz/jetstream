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
  private inflight: Promise<void> | undefined;

  override onWillAppear(): void {
    void this.refresh();
  }

  /** Poll the fleet's open PRs and roll up the worst CI state. No-ops (no `gh`) when
   * no CI key is placed. Single-flight: while a poll is in progress, an overlapping refresh (the
   * next 60s tick, or an onWillAppear) shares the one already running instead of stacking a second
   * full `gh` fan-out — so polls can never pile up and hammer the API. */
  async refresh(): Promise<void> {
    if (!this.hasKey()) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.poll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async poll(): Promise<void> {
    const next = await pollFleetCi(uniquePaths(board.projects()), config.get().ciBranchPrefix);
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
