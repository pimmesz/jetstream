import { action, SingletonAction } from '@elgato/streamdeck';
import type { KeyDownEvent, KeyUpEvent } from '@elgato/streamdeck';
import { config } from '../config';
import { runAfterburner } from '../afterburner-cli';
import { keyFace } from '../render';

/** The subset of `afterburner status --json` the face needs. Parsed defensively. */
interface Status {
  armed?: string;
  lastCycle?: string | null;
  benched?: number;
}

/**
 * The afterburner heartbeat + ignite key: shows whether the engine is alive (schedule armed
 * to spend + last cycle), plus how many tasks the failure-backoff is holding. A SHORT press
 * just refreshes; a LONG press fires a cycle (`afterburner run-once`) — deliberate, because a
 * run spends quota and opens PRs. Needs the separate `afterburner` CLI installed; shows an
 * explicit "no afterburner" state otherwise.
 */
@action({ UUID: 'gg.pim.jetstream.heartbeat' })
export class HeartbeatKey extends SingletonAction {
  private status: Status | null = null;
  private missing = false;
  private pressAt = new Map<string, number>();

  override onWillAppear(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    // No placed heartbeat key → don't spawn the CLI at all (the 60s poll is a no-op then).
    let placed = false;
    for (const _ of this.actions) {
      placed = true;
      break;
    }
    if (!placed) return;
    try {
      this.status = JSON.parse(await runAfterburner(['status', '--json'])) as Status;
      this.missing = false;
    } catch (error) {
      // Distinguish "afterburner not installed" (an expected state we guide on) from a
      // transient failure (keep the last-known status rather than blanking the key).
      if (error instanceof Error && /not installed/.test(error.message)) this.missing = true;
    }
    await this.renderAll();
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.pressAt.set(ev.action.id, Date.now());
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const started = this.pressAt.get(ev.action.id);
    this.pressAt.delete(ev.action.id);
    const held = started === undefined ? 0 : Date.now() - started;

    if (this.missing) {
      await ev.action.showAlert(); // nothing to do without the CLI
      return;
    }
    if (held < config.get().longPressMs) {
      await this.refresh(); // short press → just re-poll
      return;
    }
    // Long press → fire a real cycle. Paint "firing…", let it run detached-ish, then re-poll.
    await ev.action.setImage(keyFace({ color: '#0091ff', label: 'firing…', sub: 'run-once' }));
    try {
      await runAfterburner(['run-once'], 0); // no timeout: a cycle can take minutes
      await ev.action.showOk();
    } catch {
      await ev.action.showAlert();
    }
    await this.refresh();
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
    if (this.missing) {
      return keyFace({ color: '#26262b', label: 'afterburner', sub: 'not installed' });
    }
    const s = this.status;
    if (!s) return keyFace({ color: '#26262b', label: 'afterburner', sub: '…' });
    const alive = s.armed === 'live';
    const bench = typeof s.benched === 'number' && s.benched > 0 ? ` · ${s.benched} benched` : '';
    return keyFace({
      color: alive ? '#30a46c' : '#b58900',
      label: 'afterburner',
      subMax: 22,
      sub: (alive ? 'armed live' : s.armed === 'preview' ? 'dry-run' : 'idle') + bench,
    });
  }
}
