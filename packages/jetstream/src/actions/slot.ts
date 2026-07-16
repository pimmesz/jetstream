import { basename } from 'node:path';
import { action, SingletonAction } from '@elgato/streamdeck';
import type {
  DidReceiveSettingsEvent,
  KeyAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { worstStatus, type ProjectStatus } from '@pimmesz/jetstream-status';
import type { Face } from '../render';
import { keyFace } from '../render';
import { config } from '../config';
import { board } from '../state';
import { permissions } from '../permissions';
import { readDiffStat, type DiffStat } from '../diffstat';
import { heldMs } from '../press';
import { interruptPids, openProject } from '../switchto';
import { execPlan, runPlan } from '../slot-exec';
import { parseSlotCommand } from '../slot-command';
import { imageMime, resolveSlotIcon } from '../slot-icon';
import { buildFace } from './build';
import { stopFace } from './interrupt-all';
import { modelFace, cycleModel } from './model';
import { fleetFace, darkReason } from './fleet';
import { projectFace } from './project-face';
import { shouldInterrupt } from './project';
import { nudgeOutputVolume, toggleOutputMute } from '../output-volume';

// FOLDED structural keys + volume keys: rendered + handled here so `jetstream chat` retargets them LIVE
// (POST /slot) instead of re-importing a profile. 'build' is a static stamp; 'stopall' (gated) SIGINTs
// the fleet; 'model' cycles the global model override; 'fleet' is the live roll-up; 'volup'/'voldown'/
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
  | 'model'
  | 'fleet'
  | 'project'
  | 'volup'
  | 'voldown'
  | 'volmute'
  | 'logo'; // a decorative key painting the bundled Jetstream mark; ships on the default board, removable

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
};

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
    this.syncProjectRegistry(ev.action.id, ev.payload.settings);
    await this.render(ev.action, ev.payload.settings);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.syncProjectRegistry(ev.action.id, ev.payload.settings);
    await this.render(ev.action, ev.payload.settings);
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
      // CRITICAL: skip an UNCHANGED re-registration. render() → renderKind('project') calls
      // getSettings(), whose SDK response re-fires onDidReceiveSettings (a shared connection event);
      // without this guard that echo would setProject → board emit → renderBoard → renderKind → getSettings
      // → … an endless loop the moment a project slot is visible. Registering only on a real change
      // breaks it after one cycle.
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
    if (board.project(ev.action.id)) {
      this.diffStats.delete(ev.action.id);
      this.diffPending.delete(ev.action.id);
      board.removeProject(ev.action.id);
    }
  }

  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    const settings = ev.payload.settings;
    // 'project' is press-and-hold: arm the interrupt warning now, act on key-UP (short = open the repo,
    // long = SIGINT a working session). Every other kind acts on key-down, below.
    if (settings.kind === 'project') {
      this.projectKeyDown(ev.action);
      return;
    }
    // `stopall` SIGINTs the whole fleet — destructive, so (like the run gate) it stays inert until
    // opted in, so a webpage that plants it via the unauthenticated /slot endpoint can't fire it.
    if (settings.kind === 'stopall') {
      if (!config.get().allowStopKeys) {
        await ev.action.setImage(keyFace({ color: '#b58900', label: 'stop off', sub: 'enable in settings' }));
        setTimeout(() => void this.repaint(ev.action), 2600);
        return;
      }
      const sent = interruptPids(board.allPids());
      await (sent > 0 ? ev.action.showOk() : ev.action.showAlert());
      return;
    }
    if (settings.kind === 'model') {
      await cycleModel(); // benign — cycles the global model override; face repaints on the round-trip
      return;
    }
    if (settings.kind === 'fleet') {
      // Board lit → ack blip; dark → press-to-doctor: paint the reason for a beat, then repaint live.
      if (worstStatus(board.byProject()) !== 'none') {
        await ev.action.showOk();
        return;
      }
      await ev.action.setImage(keyFace({ color: '#b58900', label: 'why dark?', sub: darkReason() }));
      setTimeout(() => void this.repaint(ev.action), 2600);
      return;
    }
    // Output-volume keys — benign (they only move the macOS output volume), so no /slot gate needed.
    if (settings.kind === 'volup') {
      await nudgeOutputVolume(6);
      await ev.action.showOk();
      return;
    }
    if (settings.kind === 'voldown') {
      await nudgeOutputVolume(-6);
      await ev.action.showOk();
      return;
    }
    if (settings.kind === 'volmute') {
      await toggleOutputMute();
      await ev.action.showOk();
      return;
    }
    if (settings.kind === 'build') return; // a static "which build am I?" key — no press action
    if (settings.kind === 'logo') return; // decorative brand key — no press action
    // `run` executes an arbitrary command; keep it OPT-IN so a command planted via the unauthenticated
    // loopback /slot endpoint stays inert until the user enables run keys in Jetstream settings. Don't
    // dead-end silently — say WHY on the face for a beat, then restore the key.
    if (settings.kind === 'run' && !config.get().allowRunKeys) {
      await ev.action.setImage(keyFace({ color: '#b58900', label: 'run off', sub: 'enable in settings' }));
      // Repaint from the slot's LIVE settings when the notice clears: if a chat live-edit retargeted
      // this coordinate within the 2.6s, we must not paint the stale run face back over the new key.
      setTimeout(() => void this.repaint(ev.action), 2600);
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
    if (ev.payload.settings.kind !== 'project') return; // every other kind already acted on key-down
    await this.projectKeyUp(ev.action, ev.payload.settings);
  }

  // ── 'project' slot kind: per-id press + done-diff state (mirrors the standalone ProjectKey) ──
  // Short press → open the repo; long press → SIGINT its working session(s), but ONLY when working
  // and only after a deliberate hold (the face warns first). Measured key-down → key-up.
  private pressAt = new Map<string, number>();
  private holdWarn = new Map<string, ReturnType<typeof setTimeout>>();
  /** SIGINT kills the current turn, so interrupt needs a longer, deliberate hold than a generic press. */
  private static readonly INTERRUPT_HOLD_MS = 1500;
  // Per-project done-diff, fetched ONCE per done-episode off the render path and cached; cleared when
  // the project leaves 'done' or the key is re-pointed.
  private diffStats = new Map<string, DiffStat | null>();
  private diffPending = new Set<string>();

  private projectKeyDown(a: KeyAction): void {
    this.pressAt.set(a.id, Date.now());
    // Only a working session can be interrupted — arm the warning only then. Past the hold threshold,
    // flip the face so the press is visibly "about to interrupt" (still releasable to cancel).
    if (board.byProject()[a.id]?.status !== 'working') return;
    this.holdWarn.set(
      a.id,
      setTimeout(() => {
        if (board.byProject()[a.id]?.status !== 'working') return; // Stopped mid-hold → no lying warning
        void a.setImage(
          keyFace({
            color: '#e5484d', // danger red — this press is about to SIGINT the session
            label: board.project(a.id)?.name ?? 'project',
            glyph: '✕',
            sub: 'release to interrupt',
          }),
        );
      }, SlotKey.INTERRUPT_HOLD_MS),
    );
  }

  private async projectKeyUp(a: KeyAction, settings: SlotSettings): Promise<void> {
    const warned = this.clearHoldWarn(a.id);
    const held = heldMs(this.pressAt, a.id);
    const status = board.byProject()[a.id]?.status ?? 'none';
    if (shouldInterrupt(status, held, SlotKey.INTERRUPT_HOLD_MS)) {
      const sent = interruptPids(board.pidsForProject(a.id));
      await (sent > 0 ? a.showOk() : a.showAlert());
    } else {
      const path = board.project(a.id)?.path ?? settings.path;
      if (!path || !openProject(path)) await a.showAlert();
    }
    if (warned) await this.render(a, settings); // repaint over the "release to interrupt" warning
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
    this.diffPending.add(id);
    void readDiffStat(path).then((stat) => {
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
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const c = visible.coordinates;
      if (!c || c.column !== cmd.column || c.row !== cmd.row) continue;
      await visible.setSettings(cmd.settings); // full replace
      this.syncProjectRegistry(visible.id, cmd.settings); // setSettings won't re-fire onDidReceiveSettings
      await this.render(visible, cmd.settings);
      return { status: 200, body: JSON.stringify({ ok: true, coord: cmd.coord }) };
    }
    return { status: 404, body: JSON.stringify({ error: `no slot key at ${cmd.coord}` }) };
  }

  /** Repaint a slot from its CURRENT settings (used after the transient "run off" notice), so a
   * concurrent live-edit that retargeted the coordinate wins over the face we captured on press. */
  private async repaint(a: KeyAction): Promise<void> {
    if (!a.isKey()) return;
    await this.render(a, await a.getSettings());
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
        const s = await visible.getSettings();
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
    if (settings.kind === 'model') return withOverrides(modelFace(config.get().launchModel), settings);
    if (settings.kind === 'fleet') return withOverrides(fleetFace(), settings);
    return slotFace(settings);
  }

  private async render(a: KeyAction, settings: SlotSettings): Promise<void> {
    await a.setTitle('');
    if (settings.kind === 'project') {
      await this.renderProject(a, settings);
      return;
    }
    const face = this.faceFor(settings);
    // Paint the text/emoji face immediately (also the fallback when there's no image icon)…
    await a.setImage(keyFace(face));
    // …then resolve the image icon (app logo / custom image) and swap. A plain logo paints as the raw
    // image (cleanest); with a glyph override we composite so the corner badge isn't hidden.
    const icon = await resolveSlotIcon(settings);
    if (!icon) return;
    await a.setImage(face.glyph ? keyFace({ ...face, image: icon }) : icon);
  }

  /** Paint a 'project' slot as a live repo status light — resolving colour/glyph/sub + the done-diff
   * badge from board state, through the SAME `projectFace` the standalone ProjectKey uses (so the two
   * never drift). A `label` override renames it; status still drives the colour/glyph. */
  private async renderProject(a: KeyAction, settings: SlotSettings): Promise<void> {
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
    await a.setImage(keyFace(withOverrides(base, settings)));
  }
}
