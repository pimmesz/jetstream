import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent } from '@elgato/streamdeck';
import { runAfterburner } from '../afterburner-cli';
import { defaultOpenFile } from '../open-file';
import { keyFace } from '../render';

/** One PR from `afterburner review --json` (defensively typed — we read only these). */
interface Pr {
  url: string;
  ci?: string;
}

/**
 * The review queue: how many open afterburner PRs there are and how many are green
 * (ready). A press OPENS the top ready PR in the browser — deliberately open-only, NOT
 * merge: merging is irreversible + outward-facing, so it stays a considered terminal
 * action (`afterburner review`), never a key press. Needs the separate `afterburner` CLI.
 */
@action({ UUID: 'gg.pim.jetstream.review' })
export class ReviewKey extends SingletonAction {
  private prs: Pr[] = [];
  private missing = false;

  override onWillAppear(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    let placed = false;
    for (const _ of this.actions) {
      placed = true;
      break;
    }
    if (!placed) return; // no placed key → don't spawn the CLI
    try {
      const out = JSON.parse(await runAfterburner(['review', '--json'])) as {
        repos?: Array<{ prs?: Pr[] }>;
      };
      this.prs = (out.repos ?? []).flatMap((r) => r.prs ?? []);
      this.missing = false;
    } catch (error) {
      if (error instanceof Error && /not installed/.test(error.message)) this.missing = true;
    }
    await this.renderAll();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.missing) {
      await ev.action.showAlert();
      return;
    }
    // Prefer a green PR (ready to merge); else the first open one.
    const target = this.prs.find((p) => isReady(p)) ?? this.prs[0];
    const open = defaultOpenFile();
    if (target && open) {
      open(target.url); // `open`/`explorer` handle https:// URLs → default browser
      await ev.action.showOk();
    } else {
      await ev.action.showAlert();
    }
  }

  async renderAll(): Promise<void> {
    const face = this.face();
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      await visible.setTitle('');
      await visible.setImage(face);
    }
  }

  private face(): string {
    if (this.missing) return keyFace({ color: '#26262b', label: 'review', sub: 'no afterburner' });
    const n = this.prs.length;
    if (n === 0) return keyFace({ color: '#26262b', label: 'review', sub: 'no PRs' });
    const ready = this.prs.filter(isReady).length;
    return keyFace({
      color: ready > 0 ? '#30a46c' : '#b58900',
      label: 'review',
      sub: `${n} PR${n === 1 ? '' : 's'} · ${ready} ✓`,
    });
  }
}

/** A PR whose CI is green (or has nothing to wait on) — ready to open/merge. */
export function isReady(pr: Pr): boolean {
  return pr.ci === 'green' || pr.ci === 'none';
}
