import { basename } from 'node:path';
import streamDeck, { action, SingletonAction } from '@elgato/streamdeck';
import type {
  Action,
  DidReceiveSettingsEvent,
  KeyAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { worstStatus, type ProjectStatus, DANGER_RED } from '@pimmesz/jetstream-status';
import type { Face } from '../render';
import { keyFace } from '../render';
import { paintKey } from '../paint';
import { config } from '../config';
import { board } from '../state';
import { resolveCodexUsage, resolveUsage, type UsageFeed } from '@pimmesz/jetstream-usage';
import { usageFace } from './usage';
import { doorbell } from '../doorbell';
import { permissions } from '../permissions';
import { readDiffStat, type DiffStat } from '../diffstat';
import { heldMs } from '../press';
import { openProject, openProjectFromKey } from '../switchto';
import { stopSessions } from '../stop-session';
import { execPlan, runPlan } from '../slot-exec';
import { isRunTarget, parseSlotCommand, sameSlot } from '../slot-command';
import { forgetIcon, imageMime, resolveSlotIcon } from '../slot-icon';
import { buildFace } from './build';
import { stopFace } from './interrupt-all';
import { fleetFace, darkReason } from './fleet';
import { projectFace } from './project-face';
import { shouldInterrupt } from './project';
import { nudgeOutputVolume, toggleOutputMute } from '../output-volume';
import { openInTerminal } from '../exec-terminal';
import { deckForDeviceType } from '../profile';
import { editSlot, isRecord } from '../slot-inspector';

// FOLDED structural keys + volume keys: rendered + handled here so `jetstream chat` retargets them LIVE
// (POST /slot) instead of re-importing a profile. 'build' is a static stamp; 'stopall' (gated) stops
// every running turn; 'fleet' is the live roll-up; 'volup'/'voldown'/
// 'volmute' adjust the macOS OUTPUT volume; 'project' is a live per-repo status light (colour/glyph/
// diff/long-press-interrupt) — the standalone ProjectKey action folded in so a repo add/move applies
// live with no profile re-import. Only 'project' carries per-key settings (path/name). See
// docs/slot-kinds-scoping.md.
export type SlotKind =
  | 'empty'
  | 'app'
  | 'url'
  | 'run'
  | 'build'
  | 'stopall'
  | 'fleet'
  | 'project'
  | 'volup'
  | 'voldown'
  | 'volmute'
  | 'usage' // a usage gauge; `provider` picks Claude (default) or Codex
  | 'attention' // the doorbell: lights up when a project needs you (shared with the standalone key)
  | 'chat' // opens `jetstream chat` in a terminal — the board builder needs a real interactive TTY
  | 'logo'; // the bundled Jetstream mark; ships on the default board (removable). A press opens `jetstream chat`.

/** A generic, plugin-owned board key. Empty slots self-label with their coordinate; a configured
 * slot is an app / URL / command shortcut. A type ALIAS (not interface) to satisfy the SDK's
 * JsonObject index-signature constraint — same as LaunchSettings / ProjectSettings. */
export type SlotSettings = {
  kind?: SlotKind; // absent → treated as 'empty'
  label?: string; // face-label override; else derived per kind
  app?: string; // kind 'app': absolute path, e.g. /Applications/Telegram.app
  url?: string; // kind 'url': an http(s) URL
  command?: string; // kind 'run': argv[0], resolved on PATH — NEVER a shell string
  args?: string[]; // kind 'run': argument vector, one argv slot each (no splitting)
  cwd?: string; // kind 'run': working directory
  path?: string; // kind 'project': the repo root whose Claude sessions colour this key
  name?: string; // kind 'project': display name; defaults to the folder name
  icon?: string; // custom key image (a data: URI or an image file path); else an app slot shows the app's own icon
  color?: string; // face background override (#rrggbb); else the per-kind default
  sub?: string; // small second line override
  glyph?: string; // corner glyph / emoji override
  provider?: 'claude' | 'codex'; // kind 'usage': whose usage the gauge shows (default claude)
};

/** How long a transient notice ("run off", "why dark?") owns its key before the live face returns. */
const NOTICE_MS = 2600;

const appName = (app: string | undefined): string =>
  app ? basename(app).replace(/\.app$/i, '') || 'open' : 'open';

const hostLabel = (url: string | undefined): string => {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 18);
  }
};

/** The per-kind default face, before any user overrides. */
function baseFace(s: SlotSettings): Face {
  switch (s.kind) {
    case 'app':
      return { color: '#7c5cff', label: appName(s.app), top: 'open' };
    case 'url':
      return { color: '#0091ff', label: 'open', sub: hostLabel(s.url), subMax: 20 };
    case 'run':
      return { color: '#0091ff', label: s.command ?? 'run', sub: 'run', glyph: '▸' };
    case 'build':
      return buildFace(); // static, from the compile-time stamp — settings-independent
    case 'volup':
      return { color: '#1f6feb', label: 'vol +', sub: 'output' };
    case 'voldown':
      return { color: '#1f6feb', label: 'vol −', sub: 'output' };
    case 'volmute':
      return { color: '#26262b', label: 'mute', sub: 'output', glyph: '🔇' };
    case 'chat':
      return { color: '#38bdf8', label: 'chat', sub: 'build the board', subMax: 20, glyph: '💬' };
    case 'usage':
      return { color: '#26262b', label: s.provider === 'codex' ? 'codex' : 'usage', sub: 'loading' };
    case 'attention':
      return { color: '#26262b', label: 'all clear' };
    case 'logo':
      // Fallback only — the render path paints the bundled mark over this. Shown if the asset
      // can't be read (e.g. running outside the plugin bundle).
      return { color: '#0b0d12', label: 'jetstream' };
    default:
      return { color: '#1c1c20', label: '' }; // empty → a blank dark key; coordinates live on the Grid toggle
  }
}

/** True when an `icon` value is an emoji/symbol (the key's MAIN visual) rather than an image
 * reference (a data URI or a file path). */
function isEmojiIcon(icon: string): boolean {
  return !icon.startsWith('data:') && !icon.includes('/') && !imageMime(icon);
}

/** The face a slot renders. User overrides — label, colour, subtitle, glyph — win over the per-kind
 * defaults, so "make a8 red", "put 🚀 on b2", and "add subtitle 'prod'" all just paint. An emoji set
 * as the `icon` becomes the big main visual (replacing an app logo). Pure. */
/** Apply the user cosmetic overrides (label/colour/sub/glyph + an emoji main-icon) on top of any base
 * face. Split out so LIVE kinds (whose base comes from plugin state, not settings) share the same
 * override rules as the settings-derived kinds. */
function withOverrides(base: Face, s: SlotSettings): Face {
  const face: Face = {
    ...base,
    ...(s.label ? { label: s.label } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(s.sub ? { sub: s.sub } : {}),
    ...(s.glyph ? { glyph: s.glyph } : {}),
  };
  const icon = s.icon?.trim();
  if (!icon || !isEmojiIcon(icon)) return face;
  // The emoji IS the main visual; drop a corner glyph that just duplicates it (models often set both).
  if (face.glyph === icon) delete face.glyph;
  return { ...face, emoji: icon };
}

export function slotFace(s: SlotSettings): Face {
  return withOverrides(baseFace(s), s);
}

/**
 * A self-labeling board slot. Empty keys show their a8-style coordinate; a configured slot opens an
 * app or URL, or runs a command, on press. Because the plugin owns every slot, `jetstream chat` can
 * retarget any coordinate LIVE (see `assign`) with no profile re-import.
 */
@action({ UUID: 'gg.pim.jetstream.slot' })
export class SlotKey extends SingletonAction<SlotSettings> {
  override async onWillAppear(ev: WillAppearEvent<SlotSettings>): Promise<void> {
    if (!ev.action.isKey()) return; // keypad-only; a dial has no board coordinate
    this.heldSettings.set(ev.action.id, ev.payload.settings);
    this.syncProjectRegistry(ev.action.id, ev.payload.settings);
    await this.render(ev.action, ev.payload.settings);
    if (ev.payload.settings.kind === 'usage') void this.refreshUsage(); // fill the gauge without waiting for the timer
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.heldSettings.set(ev.action.id, ev.payload.settings);
    this.syncProjectRegistry(ev.action.id, ev.payload.settings);
    await this.render(ev.action, ev.payload.settings);
  }

  override async onSendToPlugin(ev: { action: Action<SlotSettings>; payload: unknown }): Promise<void> {
    const message = ev.payload;
    if (!isRecord(message) || (message.slot !== 'read' && message.slot !== 'save') ||
        typeof message.requestId !== 'string' || message.requestId.length > 100 || !ev.action.isKey()) return;
    const requestId = message.requestId;
    const key = ev.action;
    const reply = async (payload: { ok: boolean; settings?: SlotSettings; error?: string }): Promise<void> => {
      // The user may select another key while a write or render is pending.
      if (streamDeck.ui.action?.id !== key.id) return;
      await streamDeck.ui.sendToPropertyInspector({
        slot: 'result', actionId: key.id, requestId, ...payload,
      });
    };
    try {
      const result = await this.queued(key.id, async () => {
        if (![...this.actions].some((a) => a.id === key.id)) {
          return { ok: false as const, error: 'This slot is no longer visible. Select it again.' };
        }
        const current = await this.settingsOf(key);
        if (message.slot === 'read') {
          this.heldSettings.set(key.id, current);
          return { ok: true as const, settings: current };
        }
        const edit = editSlot(current, message.expect, message.edit);
        if (!edit.ok) return edit;
        const seq = (this.assignSeq.get(key.id) ?? 0) + 1;
        this.assignSeq.set(key.id, seq);
        try {
          await key.setSettings(edit.settings);
        } catch (error) {
          // A timeout may follow a persisted write. Reload before accepting another edit.
          this.heldSettings.delete(key.id);
          throw error;
        }
        this.heldSettings.set(key.id, edit.settings);
        this.syncProjectRegistry(key.id, edit.settings);
        return { ...edit, seq };
      });
      await reply(result);
      if (result.ok && 'seq' in result) await this.renderAssigned(key, result.settings, result.seq);
    } catch {
      await reply({ ok: false, error: 'Could not confirm the save or refresh. Choose Cancel to reload before trying again.' });
    }
  }

  /** A slot of kind 'project' represents a repo, so it must join the board registry (keyed by the
   * Stream Deck action id, like ProjectKey does) for its live Claude sessions to colour it and for the
   * Fleet/Attention roll-ups to cover it. Idempotent; deregisters + drops per-id state when a slot is
   * retargeted AWAY from 'project'. MUST also be called from `assign()` — setSettings does not re-fire
   * onDidReceiveSettings in-plugin, so a live retarget would otherwise never (de)register. */
  private syncProjectRegistry(id: string, settings: SlotSettings): void {
    if (settings.kind === 'project') {
      const path = settings.path ?? '';
      const name = settings.name?.trim() || (path ? basename(path) : 'set path');
      const prev = board.project(id);
      // Skip an UNCHANGED re-registration: setProject emits a board change that repaints every key, so a
      // repeat event with the same path and name must not cause one.
      if (prev?.path === path && prev?.name === name) return;
      // A re-point to a DIFFERENT repo (or a first registration) cancels any in-flight hold gesture and
      // drops the stale diff badge; a name-only change keeps the badge (avoids a needless git re-read).
      if (prev?.path !== path) {
        this.clearHoldWarn(id);
        this.pressAt.delete(id);
        this.diffStats.delete(id);
      }
      board.setProject(id, { name, path });
    } else if (board.project(id)) {
      // this key WAS a project and is now something else → deregister + drop its per-id state
      this.clearHoldWarn(id);
      this.pressAt.delete(id);
      this.diffStats.delete(id);
      this.diffPending.delete(id);
      board.removeProject(id);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
    this.clearHoldWarn(ev.action.id);
    this.pressAt.delete(ev.action.id); // WillDisappear doesn't call syncProjectRegistry — clear the gesture here too
    this.heldSettings.delete(ev.action.id);
    // A key comes back blank, so its old notice must not block the live paint. The notice's timer
    // then finds no matching entry and only repaints.
    this.noticeUntil.delete(ev.action.id);
    if (board.project(ev.action.id)) {
      this.diffStats.delete(ev.action.id);
      this.diffPending.delete(ev.action.id);
      board.removeProject(ev.action.id);
    }
  }

  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    const settings = ev.payload.settings;
    // 'project' is press-and-hold: arm the interrupt warning now, act on key-UP (short = open the repo,
    // long = stop a working session's turn). Every other kind acts on key-down, below.
    if (settings.kind === 'project') {
      this.projectKeyDown(ev.action);
      return;
    }
    // The doorbell acts on key-UP: a long hold snoozes, a tap jumps to the neediest project.
    if (settings.kind === 'attention') {
      this.pressAt.set(ev.action.id, Date.now());
      return;
    }
    // `stopall` stops every running turn in the fleet. It is disruptive, so (like the run gate) it stays
    // inert until opted in, so a webpage that plants it via the unauthenticated /slot endpoint can't fire it.
    if (settings.kind === 'stopall') {
      if (!config.get().allowStopKeys) {
        const until = Date.now() + NOTICE_MS;
        this.noticeUntil.set(ev.action.id, until);
        await paintKey(ev.action, keyFace({ color: '#b58900', label: 'stop off', sub: 'allow in projects.json', subMax: 22 }));
        setTimeout(() => this.endNotice(ev.action, until), NOTICE_MS);
        return;
      }
      const sent = stopSessions(board.allActiveSessions());
      await (sent > 0 ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    if (settings.kind === 'usage') {
      // A press re-reads now instead of waiting for the timer, and always answers: like the standalone
      // Usage key, an alert when the read fails or the gauge still has no usage.
      let read: ReadonlyMap<'claude' | 'codex', UsageFeed>;
      try {
        read = await this.refreshUsage();
      } catch {
        await ev.action.showAlert();
        return;
      }
      const provider = settings.provider ?? 'claude';
      const feed = read.get(provider) ?? this.usageFeeds.get(provider);
      await (feed?.available ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    if (settings.kind === 'fleet') {
      // Board lit → ack blip; dark → press-to-doctor: paint the reason for a beat, then repaint live.
      if (worstStatus(board.byProject()) !== 'none') {
        await ev.action.showOk();
        return;
      }
      const until = Date.now() + NOTICE_MS;
      this.noticeUntil.set(ev.action.id, until);
        await paintKey(ev.action, keyFace({ color: '#b58900', label: 'why dark?', sub: darkReason() }));
      setTimeout(() => this.endNotice(ev.action, until), NOTICE_MS);
      return;
    }
    // Output-volume keys — benign (they only move the macOS output volume), so no /slot gate needed.
    if (settings.kind === 'volup') {
      // Alert rather than ✓ when nothing moved — on a volume-fixed interface, or when the helper
      // failed, an unconditional showOk claimed success for a guaranteed no-op.
      await ((await nudgeOutputVolume(6)) ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    if (settings.kind === 'voldown') {
      // Alert rather than ✓ when nothing moved — on a volume-fixed interface, or when the helper
      // failed, an unconditional showOk claimed success for a guaranteed no-op.
      await ((await nudgeOutputVolume(-6)) ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    if (settings.kind === 'volmute') {
      // Alert rather than ✓ when nothing moved — on a volume-fixed interface, or when the helper
      // failed, an unconditional showOk claimed success for a guaranteed no-op.
      await ((await toggleOutputMute()) ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    // `chat` opens a TERMINAL running `jetstream chat` — the conversational board builder needs an
    // interactive TTY, so the plugin can only launch it, not host it. Safe to leave ungated: the
    // command is a compile-time constant (no user input reaches the launcher) and it only starts an
    // interactive session the user then drives by hand.
    if (settings.kind === 'chat') {
      const opened = await openInTerminal('chat');
      await (opened ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    if (settings.kind === 'build') return; // a static "which build am I?" key — no press action
    // The bundled brand key doubles as a chat launcher: a press opens `jetstream chat`. Same
    // compile-time-constant command as the 'chat' kind (no user input reaches the launcher), so
    // it needs no gate.
    if (settings.kind === 'logo') {
      const opened = await openInTerminal('chat');
      await (opened ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    // `run` executes an arbitrary command; keep it OPT-IN so a command planted via the unauthenticated
    // loopback /slot endpoint stays inert until the user opts in via the projects.json settings
    // preset (`"allowRunKeys": true`) — deliberately a different channel from /slot itself. Don't
    // dead-end silently — say WHY on the face for a beat, then restore the key.
    const shouldGateAsRun = settings.kind === 'run' || (settings.kind === 'app' && (await isRunTarget(settings.app)));
    if (shouldGateAsRun && !config.get().allowRunKeys) {
      await this.showRunOff(ev.action);
      return;
    }
    const plan = execPlan(settings);
    if (!plan) {
      await ev.action.showAlert(); // empty or invalid slot → harmless "nothing here" hint
      return;
    }
    if (runPlan(plan)) await ev.action.showOk();
    else await ev.action.showAlert();
  }

  override async onKeyUp(ev: KeyUpEvent<SlotSettings>): Promise<void> {
    if (ev.payload.settings.kind === 'attention') {
      const result = doorbell.press(heldMs(this.pressAt, ev.action.id));
      if (result.act === 'jump' && result.path && !(await openProjectFromKey(result.path))) await ev.action.showAlert();
      return;
    }
    if (ev.payload.settings.kind !== 'project') return; // every other kind already acted on key-down
    await this.projectKeyUp(ev.action, ev.payload.settings);
  }

  // ── 'project' slot kind: per-id press + done-diff state (mirrors the standalone ProjectKey) ──
  // Short press → open the repo; long press → stop its working turn(s), but ONLY when working
  // and only after a deliberate hold (the face warns first). Measured key-down → key-up.
  private pressAt = new Map<string, number>();
  private holdWarn = new Map<string, ReturnType<typeof setTimeout>>();
  /** Key id → epoch ms until which a transient notice ("run off", "why dark?") owns the key and
   * must not be repainted over by a routine board render. */
  private noticeUntil = new Map<string, number>();
  /** Key id → count of live edits (`assign`) started, so a slow edit can tell a newer one landed. */
  private assignSeq = new Map<string, number>();
  /** The last usage read per provider, painted by every usage slot of that provider. */
  private usageFeeds = new Map<'claude' | 'codex', UsageFeed>();
  private usageGeneration = 0;

  /** Re-read usage for the providers that have a gauge on screen, then repaint those gauges. Resolves
   * with the feeds this call read, even when a newer refresh superseded it, so a press answers from its own read. */
  async refreshUsage(): Promise<ReadonlyMap<'claude' | 'codex', UsageFeed>> {
    const providers = new Set<'claude' | 'codex'>();
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      try {
        const s = await this.settingsOf(visible);
        if (s.kind === 'usage') providers.add(s.provider ?? 'claude');
      } catch {
        /* one slot's getSettings timeout must not stop every other gauge from refreshing */
      }
    }
    if (providers.size === 0) return new Map();
    const generation = ++this.usageGeneration;
    const feeds = new Map(
      await Promise.all(
        [...providers].map(async (p) => [p, p === 'codex' ? await resolveCodexUsage() : await resolveUsage()] as const),
      ),
    );
    if (generation !== this.usageGeneration) return feeds; // a newer refresh owns the faces
    for (const [p, feed] of feeds) this.usageFeeds.set(p, feed);
    await this.renderKind('usage');
    return feeds;
  }
  /** A stop cuts the current turn short, so it needs a longer, deliberate hold than a generic press. */
  private static readonly INTERRUPT_HOLD_MS = 1500;
  // Per-project done-diff, fetched ONCE per done-episode off the render path and cached; cleared when
  // the project leaves 'done' or the key is re-pointed.
  private diffStats = new Map<string, DiffStat | null>();
  /** Key id → token of its in-flight diff read, so a read from an earlier done episode is dropped. */
  private diffPending = new Map<string, object>();

  private projectKeyDown(a: KeyAction<SlotSettings>): void {
    this.pressAt.set(a.id, Date.now());
    // Only a working session can be interrupted — arm the warning only then. Past the hold threshold,
    // flip the face so the press is visibly "about to interrupt" (still releasable to cancel).
    if (board.byProject()[a.id]?.status !== 'working') return;
    this.holdWarn.set(
      a.id,
      setTimeout(() => {
        if (board.byProject()[a.id]?.status !== 'working') return; // Stopped mid-hold → no lying warning
        // Through paintKey like every other paint here — a raw upload would leave the cache holding
        // the pre-warning face, so releasing back onto it would be skipped as identical and strand
        // the key on this red warning (the same bug this cost us in fleet.ts and project.ts).
        void paintKey(
          a,
          keyFace({
            color: DANGER_RED, // danger red: this press is about to stop the turn
            label: board.project(a.id)?.name ?? 'project',
            glyph: '✕',
            sub: 'release to interrupt',
          }),
        );
      }, SlotKey.INTERRUPT_HOLD_MS),
    );
  }

  private async projectKeyUp(a: KeyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
    const warned = this.clearHoldWarn(a.id);
    const held = heldMs(this.pressAt, a.id);
    const status = board.byProject()[a.id]?.status ?? 'none';
    if (shouldInterrupt(status, held, SlotKey.INTERRUPT_HOLD_MS)) {
      const sent = stopSessions(board.activeSessionsForProject(a.id));
      await (sent > 0 ? a.showOk() : a.showAlert());
    } else {
      const path = board.project(a.id)?.path ?? settings.path;
      // A repo is a folder; a file here would go to the OS opener, which runs an executable or script.
      if (path && !config.get().allowRunKeys && (await isRunTarget(path))) {
        await this.showRunOff(a);
        return;
      }
      if (!path || !openProject(path)) await a.showAlert();
    }
    if (warned) await this.render(a, settings); // repaint over the "release to interrupt" warning
  }

  /** Say why a run-like key did nothing, then give the face back. */
  private async showRunOff(a: KeyAction<SlotSettings>): Promise<void> {
    const until = Date.now() + NOTICE_MS;
    this.noticeUntil.set(a.id, until);
    await paintKey(a, keyFace({ color: '#b58900', label: 'run off', sub: 'allow in projects.json', subMax: 22 }));
    // Repaint from the slot's LIVE settings when the notice clears: if a chat live-edit retargeted
    // this coordinate within the 2.6s, we must not paint the stale run face back over the new key.
    setTimeout(() => this.endNotice(a, until), NOTICE_MS);
  }

  /** Give a notice's key back. Release by identity, not the clock: the timer can fire 1 ms short of
   * `until`, which the render guard would skip, and a newer notice keeps the key until its own timer. */
  private endNotice(a: KeyAction<SlotSettings>, until: number): void {
    if (this.noticeUntil.get(a.id) === until) this.noticeUntil.delete(a.id);
    void this.repaint(a);
  }

  /** Clear a key's pending interrupt-warning timer; returns whether one was armed. */
  private clearHoldWarn(id: string): boolean {
    const timer = this.holdWarn.get(id);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.holdWarn.delete(id);
    return true;
  }

  /** Fetch the done-diff once, off the hot render path — async + cached, cleared when the project
   * leaves 'done'. readDiffStat never throws (null on any failure). Repaints project slots when known. */
  private trackDiff(id: string, status: ProjectStatus, path: string | undefined): void {
    if (status !== 'done') {
      this.diffStats.delete(id);
      this.diffPending.delete(id);
      return;
    }
    if (!path || this.diffStats.has(id) || this.diffPending.has(id)) return;
    const token = {};
    this.diffPending.set(id, token);
    void readDiffStat(path).then((stat) => {
      // The episode this read was for ended (the key left 'done' and maybe came back): drop it.
      if (this.diffPending.get(id) !== token) return;
      this.diffPending.delete(id);
      if (board.project(id)?.path !== path) return; // re-pointed mid-read → drop the stale result
      this.diffStats.set(id, stat);
      void this.renderKind('project'); // repaint now the badge is known (cache stops a re-fetch)
    });
  }

  /**
   * Retarget the slot at a coordinate from a `POST /slot` body — the live-edit path. The SDK offers
   * no key lookup, so we scan the visible instances of this action for the matching coordinate. It's
   * visible-only: a slot on another profile/page won't be found → 404 (the CLI surfaces "switch to
   * your board"). setSettings persists, so the change survives restart.
   */
  async assign(raw: unknown): Promise<{ status: number; body: string }> {
    const cmd = parseSlotCommand(raw);
    if (!cmd) return { status: 400, body: JSON.stringify({ error: 'bad slot command' }) };
    // The same coordinate exists on every connected deck; chat names the deck model its plan is for.
    const deck = (raw as { deck?: unknown } | null)?.deck;
    const matches: KeyAction<SlotSettings>[] = [];
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const c = visible.coordinates;
      if (!c || c.column !== cmd.column || c.row !== cmd.row) continue;
      if (deck !== undefined && deckForDeviceType(visible.device.type)?.key !== deck) continue;
      matches.push(visible);
    }
    if (matches.length === 0) {
      return { status: 404, body: JSON.stringify({ error: `no slot key at ${cmd.coord}` }) };
    }
    // Guessing could edit a deck the user never previewed. 404 (not 409) because every released chat
    // reads 404 as "nothing changed" and offers the restart write into the planned profile.
    if (matches.length > 1) {
      return { status: 404, body: JSON.stringify({ error: `${cmd.coord} is a slot key on more than one Stream Deck` }) };
    }
    const visible = matches[0]!;
    // Compare-and-swap: chat says what it expects at this key. Anything else (the deck switched page,
    // another edit landed) is refused before a single setting changes. The compare and the write run
    // queued per key, so two overlapping requests cannot both pass the compare.
    const expected = (raw as { expect?: unknown } | null)?.expect;
    const seq = await this.queued(visible.id, async () => {
      if (expected !== undefined && !sameSlot(await this.settingsOf(visible), expected)) return undefined;
      const next = (this.assignSeq.get(visible.id) ?? 0) + 1;
      this.assignSeq.set(visible.id, next);
      await visible.setSettings(cmd.settings); // full replace
      this.heldSettings.set(visible.id, cmd.settings);
      this.syncProjectRegistry(visible.id, cmd.settings);
      return next;
    });
    if (seq === undefined) {
      return { status: 409, body: JSON.stringify({ error: `${cmd.coord} holds a different key than expected` }) };
    }
    await this.renderAssigned(visible, cmd.settings, seq);
    return { status: 200, body: JSON.stringify({ ok: true, coord: cmd.coord }) };
  }

  /** Both the inspector and chat need the same icon refresh and stale-paint protection. */
  private async renderAssigned(visible: KeyAction<SlotSettings>, settings: SlotSettings, seq: number): Promise<void> {
    // Re-resolve this key's icon instead of trusting the cache. A cached MISS is otherwise
    // permanent for the life of the plugin: an app that wasn't installed yet, or an extraction
    // that lost a race at startup, would leave the key on its text face with no way to recover
    // through the UI. Retargeting a key is an explicit user action and the one moment we know
    // the answer might have changed, so it is exactly where the cache should be dropped.
    forgetIcon(settings.app);
    forgetIcon(settings.icon);
    await this.render(visible, settings);
    // A newer edit (chat's rollback after this one timed out) landed while this render waited on an
    // icon, so this paint is stale: repaint from the settings the key really holds now.
    // Repeat until no edit landed during the repaint itself, so the last paint is always the newest.
    for (let seen = seq; this.assignSeq.get(visible.id) !== seen; ) {
      seen = this.assignSeq.get(visible.id) ?? seen;
      await this.repaint(visible);
    }
    if (settings.kind === 'usage') void this.refreshUsage();
  }

  /** Key id → tail of its queue of compare-and-write steps. */
  private writeQueue = new Map<string, Promise<unknown>>();

  /** Run `step` after every earlier queued step for the same key. */
  private queued<T>(id: string, step: () => Promise<T>): Promise<T> {
    const run = (this.writeQueue.get(id) ?? Promise.resolve()).then(step);
    this.writeQueue.set(id, run.catch(() => undefined));
    return run;
  }

  /** Key id → the settings the key holds, as Stream Deck last sent them or this plugin last wrote them.
   * The SDK's own cache can be refilled by a getSettings reply sent before a write, so we keep our own. */
  private heldSettings = new Map<string, SlotSettings>();

  /** What a slot key holds; asks Stream Deck only for a key this plugin has no record of. */
  private async settingsOf(a: KeyAction<SlotSettings>): Promise<SlotSettings> {
    return this.heldSettings.get(a.id) ?? (await a.getSettings());
  }

  /** Repaint a slot from its CURRENT settings (used after the transient "run off" notice), so a
   * concurrent live-edit that retargeted the coordinate wins over the face we captured on press. */
  private async repaint(a: KeyAction<SlotSettings>): Promise<void> {
    if (!a.isKey()) return;
    await this.render(a, await this.settingsOf(a));
  }

  /** Repaint only the visible slots of a given KIND. The board tick / a poll / a subscription calls
   * this to refresh LIVE kinds (e.g. 'stopall' working-count) without touching static slots. Timers
   * stay in plugin.ts (one per kind); this is the O(kinds) redirect target. */
  async renderKind(kind: SlotKind): Promise<void> {
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      // A project key mid-interrupt-hold shows the "release to interrupt" warning — a routine repaint
      // (board tick / subscription) must not wipe it. Entry lives key-down → key-up.
      if (kind === 'project' && this.holdWarn.has(visible.id)) continue;
      try {
        const s = await this.settingsOf(visible);
        if (s.kind === kind) await this.render(visible, s);
      } catch {
        /* a transient getSettings/render timeout for one slot must not abort the rest (or reject) */
      }
    }
  }

  /** The face for a slot, resolving LIVE kinds (e.g. 'stopall' reads the board working-count) from
   * plugin state; settings-derived kinds go through the pure `slotFace`. */
  private faceFor(settings: SlotSettings): Face {
    if (settings.kind === 'stopall') {
      const working = Object.values(board.byProject()).filter((s) => s.status === 'working').length;
      return withOverrides(stopFace(working), settings);
    }
    if (settings.kind === 'fleet') return withOverrides(fleetFace(), settings);
    if (settings.kind === 'attention') return withOverrides(doorbell.face(), settings);
    if (settings.kind === 'usage') {
      const provider = settings.provider ?? 'claude';
      const feed = this.usageFeeds.get(provider);
      return feed ? withOverrides(usageFace(feed, Date.now(), provider), settings) : slotFace(settings);
    }
    return slotFace(settings);
  }

  private async render(a: KeyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
    // A transient notice OWNS the key for its couple of seconds. Otherwise any board emit (the
    // 100ms debounce) or the 30s tick repaints the live face straight over it — and stop-all is
    // pressed exactly when sessions are working, i.e. when emits are densest, so the explanation
    // for why the press did nothing was routinely erased before it could be read. `holdWarn` gave
    // project keys this guard already; these three notices had none.
    if ((this.noticeUntil.get(a.id) ?? 0) > Date.now()) return;
    await a.setTitle('');
    if (settings.kind === 'project') {
      await this.renderProject(a, settings);
      return;
    }
    const face = this.faceFor(settings);
    // Resolve the icon FIRST, then paint ONCE. Painting the text face and swapping to the icon
    // afterwards uploaded two different images on every render — and since a slot is re-rendered on
    // every board change (renderKind), that second image guaranteed a visible flash on every hook
    // event, which no cache can absorb because the two faces genuinely differ. Icon resolution is
    // cached, so this costs nothing after the first paint; on a cold cache the key simply holds its
    // previous face a moment longer instead of flashing text at you.
    const icon = await resolveSlotIcon(settings);
    // An edit that landed while the icon resolved owns the face now; this older snapshot must not undo it.
    const held = this.heldSettings.get(a.id);
    if (held !== undefined && !sameSlot(held, settings)) return;
    // A plain image paints as the raw icon (cleanest); with a glyph override we composite so the
    // corner badge isn't hidden by the image.
    const image = icon ? (face.glyph ? keyFace({ ...face, image: icon }) : icon) : keyFace(face);
    await paintKey(a, image);
  }

  /** Paint a 'project' slot as a live repo status light — resolving colour/glyph/sub + the done-diff
   * badge from board state, through the SAME `projectFace` the standalone ProjectKey uses (so the two
   * never drift). A `label` override renames it; status still drives the colour/glyph. */
  private async renderProject(a: KeyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
    const now = Date.now();
    const id = a.id;
    const project = board.project(id);
    const path = project?.path ?? settings.path;
    const state = board.byProject()[id] ?? { status: 'none' as const };
    this.trackDiff(id, state.status, path);
    const base = projectFace({
      name: project?.name ?? (settings.name?.trim() || 'project'),
      configured: Boolean(path),
      status: state.status,
      since: state.since,
      tool: state.tool,
      answerable: permissions.projectsWithPending(board.projects()).has(id),
      diffStat: this.diffStats.get(id) ?? null,
      now,
      theme: config.get().theme,
    });
    // Status drives the DEFAULT colour/glyph/sub, but an explicit override still wins (rename via
    // `label`, `color`, `sub`, `glyph`, an emoji `icon`) — consistent with every other slot kind.
    await paintKey(a, keyFace(withOverrides(base, settings)));
  }
}
