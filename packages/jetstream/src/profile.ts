import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { NavSettings } from './actions/nav';
import type { PermissionSettings } from './actions/permission';
import type { ProjectSettings } from './actions/project';
import type { Placement } from './layout';

/**
 * Generate a ready-made Jetstream key layout as a double-clickable `.streamDeckProfile`,
 * so init can hand the user a working board instead of drag-these-keys instructions.
 *
 * The emitted schema is the flat `Version:"1.0"` profile manifest ({Actions:{"col,row":…},
 * DeviceModel, Name}) mirrored byte-for-byte in shape from the profiles Elgato itself still
 * ships and the current app still consumes (com.elgato.tutorial's bundled
 * *.streamDeckProfile, verified locally against app 7.5) — grounded in a real, first-party
 * import artifact rather than the undocumented on-disk ProfilesV3 store. Importing is
 * additive by design: the app installs it as a NEW profile on a device the user picks in
 * the import dialog, so it can never overwrite an existing layout.
 */

export interface DeckModel {
  key: 'mini' | 'standard' | 'xl';
  label: string;
  /** DeviceModel code, each taken from a first-party Elgato profile for that device. */
  model: string;
  cols: number;
  rows: number;
}

export const DECK_MODELS: DeckModel[] = [
  { key: 'mini', label: 'Stream Deck Mini (6 keys)', model: '20GAI9901', cols: 3, rows: 2 },
  { key: 'standard', label: 'Stream Deck / MK.2 (15 keys)', model: '20GBA9901', cols: 5, rows: 3 },
  { key: 'xl', label: 'Stream Deck XL (32 keys)', model: '20GAT9901', cols: 8, rows: 4 },
];

/** The Stream Deck app's ProfilesV3 store, per OS. Linux has no Stream Deck app; the darwin
 * path is returned there and every reader falls back safely when it doesn't exist. */
function profilesStoreDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Elgato', 'StreamDeck', 'ProfilesV3');
  }
  return join(homedir(), 'Library', 'Application Support', 'com.elgato.StreamDeck', 'ProfilesV3');
}

/** The exact DeviceModel code of the CONNECTED deck in `deck`'s family, sniffed from the app's
 * ProfilesV3 store. A generated profile's DeviceModel must match the connected hardware — an XL
 * ships as 20GAT9901 or 20GAT9902 and other decks have revisions too — or Stream Deck won't
 * import it onto the device. When several profiles match the family (e.g. a replaced device's
 * stale profiles), the most recently MODIFIED profile wins — that's the deck actually in use.
 * One unreadable profile never aborts the scan. Falls back to the family default when nothing
 * matches. `profilesDir` is injectable so tests never touch the real store. */
export function detectDeviceModel(deck: DeckModel, profilesDir = profilesStoreDir()): string {
  const prefix = deck.model.slice(0, 7); // '20GAT99' (XL), '20GBA99' (MK.2), '20GAI99' (Mini)
  let entries: string[];
  try {
    entries = readdirSync(profilesDir);
  } catch {
    return deck.model; // Stream Deck not installed / no profile store — use the family default
  }
  let best: { model: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.endsWith('.sdProfile')) continue;
    try {
      const dir = join(profilesDir, entry);
      const match = /"Model":"(20[0-9A-Z]+)"/.exec(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      if (!match?.[1]?.startsWith(prefix)) continue;
      const mtimeMs = statSync(dir).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { model: match[1], mtimeMs };
    } catch {
      continue; // a profile without a readable manifest tells us nothing — keep scanning
    }
  }
  return best?.model ?? deck.model;
}

/** The Stream Deck the app currently has profiles for, sniffed from its ProfilesV3 store by
 * DeviceModel prefix (each deck family has a stable 7-char code — see DECK_MODELS). Returns the
 * matched DeckModel, or undefined when nothing matches or MORE than one family is present
 * (ambiguous → let the user pick). Best-effort and side-effect-free: any read error → undefined.
 * `profilesDir` is injectable so tests never touch the real store. */
export function detectConnectedDeck(profilesDir = profilesStoreDir()): DeckModel | undefined {
  const byPrefix = new Map(DECK_MODELS.map((d) => [d.model.slice(0, 7), d]));
  const found = new Set<DeckModel>();
  try {
    for (const entry of readdirSync(profilesDir)) {
      if (!entry.endsWith('.sdProfile')) continue;
      let model: string | undefined;
      try {
        const raw = readFileSync(join(profilesDir, entry, 'manifest.json'), 'utf8');
        model = /"Model"\s*:\s*"(20[0-9A-Z]+)"/.exec(raw)?.[1];
      } catch {
        continue; // a profile without a readable manifest tells us nothing — skip it
      }
      const deck = model && byPrefix.get(model.slice(0, 7));
      if (deck) found.add(deck);
    }
  } catch {
    return undefined; // no store / unreadable dir — fall back to asking
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** One placed action, in the shape the V1 profile manifest expects. */
interface ProfileAction {
  Name: string;
  Settings: Record<string, unknown> | null;
  State: number;
  States: Array<Record<string, string>>;
  UUID: string;
}

/** The default single state block the tutorial profiles use for a plugin-rendered key. */
const STATE = {
  FFamily: '',
  FSize: '18',
  FStyle: '',
  FUnderline: 'off',
  Image: '',
  Title: '',
  TitleAlignment: 'middle',
  TitleColor: '#ededff',
  TitleShow: '',
};

const action = (name: string, uuid: string, settings: Record<string, unknown> | null = null): ProfileAction => ({
  Name: name,
  Settings: settings,
  State: 0,
  States: [{ ...STATE }],
  UUID: uuid,
});

/** Fill every board coordinate that has no action yet with an empty, self-labeling Slot key, so ONE
 * import makes the whole deck plugin-owned: empty keys then render their own a8-style coordinate and
 * can be retargeted live (POST /slot) without ever generating another profile. Mutates `slots`. */
function fillEmptySlots(slots: Map<string, ProfileAction>, deck: DeckModel): void {
  for (let row = 0; row < deck.rows; row++) {
    for (let col = 0; col < deck.cols; col++) {
      const slot = `${col},${row}`;
      if (!slots.has(slot)) slots.set(slot, action('Empty slot', 'gg.pim.jetstream.slot', { kind: 'empty' }));
    }
  }
}

export interface BuiltProfile {
  /** The profile manifest, ready to stringify. */
  manifest: Record<string, unknown>;
  /** How many project keys made it onto the grid. */
  placedProjects: number;
  /** Projects that didn't fit (or the deck has no room for project keys at all). */
  skippedProjects: number;
}

/** The fixed keys every Jetstream board shares (both the shipped default and init's
 * personalized layout — same slots, so upgrading feels like filling in the same board).
 * Controls anchor a coherent BOTTOM zone so the project keys own the top of the deck and
 * flow left-to-right (Fleet/Attention/Usage/CI on the bottom row, Approve/Deny + Launch
 * beside them, Settings bottom-right, a Page:Ops nav cap). The Mini keeps its two-row
 * essentials (no project keys, so nothing to anchor). Returns the slot map. */
function fixedLayout(deck: DeckModel): Map<string, ProfileAction> {
  const slots = new Map<string, ProfileAction>();
  const at = (col: number, row: number, entry: ProfileAction): void => {
    slots.set(`${col},${row}`, entry);
  };
  // The literals are type-checked against the actions' OWN settings types, so a
  // renamed field breaks the build here instead of shipping a dead key.
  const allow = { decision: 'allow' } satisfies PermissionSettings;
  const deny = { decision: 'deny' } satisfies PermissionSettings;
  const ops = { target: 'ops' } satisfies NavSettings;

  if (deck.key === 'mini') {
    // 6 keys: the fleet covers every repo, so the Mini gets the essentials only.
    at(0, 0, action('Fleet roll-up', 'gg.pim.jetstream.fleet'));
    at(1, 0, action('Attention', 'gg.pim.jetstream.attention'));
    at(2, 0, action('Usage gauge', 'gg.pim.jetstream.usage'));
    at(0, 1, action('Approve', 'gg.pim.jetstream.permission', allow));
    at(1, 1, action('Deny', 'gg.pim.jetstream.permission', deny));
    at(2, 1, action('Jetstream settings', 'gg.pim.jetstream.settings'));
    return slots;
  }

  if (deck.key === 'xl') {
    // On the XL every project gets its own key, so the roll-up + overflow keys are dropped: the
    // board is projects plus three touches — the Usage gauge on d1, Jetstream settings beside it on
    // d2 (a press opens `jetstream doctor`, and its inspector holds theme/timings/fleet), and the
    // Jetstream mark in the top-right corner (a8). Approve/Deny are left OFF here: they add little
    // when every repo has its own key, and nothing at all if you run with permissions bypassed —
    // add them in the app or via `jetstream chat`. The smaller decks keep their control strips,
    // where projects overflow and those keys earn their spot.
    at(0, 3, action('Usage gauge', 'gg.pim.jetstream.usage'));
    at(1, 3, action('Jetstream settings', 'gg.pim.jetstream.settings'));
    at(7, 0, action('Jetstream', 'gg.pim.jetstream.slot', { kind: 'logo' }));
    return slots;
  }

  // Standard (5x3): bottom row = watch strip + Settings; Nav/Approve/Deny sit on the
  // right of row 1, leaving row 0 + the left of row 1 (7 slots) for projects.
  at(0, 2, action('Fleet roll-up', 'gg.pim.jetstream.fleet'));
  at(1, 2, action('Attention', 'gg.pim.jetstream.attention'));
  at(2, 2, action('Usage gauge', 'gg.pim.jetstream.usage'));
  at(4, 2, action('Jetstream settings', 'gg.pim.jetstream.settings'));
  at(2, 1, action('Page: Ops', 'gg.pim.jetstream.nav', ops));
  at(3, 1, action('Approve', 'gg.pim.jetstream.permission', allow));
  at(4, 1, action('Deny', 'gg.pim.jetstream.permission', deny));
  return slots;
}

/** Where project keys seed FIRST: the top row, left-to-right (a contiguous top-left block
 * is what reads as "my projects", not a centered island). Overflow then spills row-major
 * into the remaining free slots above the control strip. */
function preferredProjectSlots(deck: DeckModel): string[] {
  if (deck.key === 'xl') return ['0,0', '1,0', '2,0', '3,0', '4,0', '5,0'];
  if (deck.key === 'standard') return ['0,0', '1,0', '2,0'];
  return [];
}

/**
 * Lay out the personalized Jetstream board (`jetstream init`): the shared fixed keys
 * plus Project keys (name+path prefilled) — the top-left preferred slots first, then any
 * remaining free slot row-major (which, with controls on the bottom, is a contiguous
 * top-anchored block). Pure.
 */
export function buildProfile(
  deck: DeckModel,
  projects: ProjectConfig[],
  deviceModel: string = deck.model,
): BuiltProfile {
  const slots = fixedLayout(deck);

  let placed = 0;
  const place = (slot: string): void => {
    const project = projects[placed]!;
    const settings = { name: project.name, path: project.path } satisfies ProjectSettings;
    slots.set(slot, action('Project status', 'gg.pim.jetstream.project', settings));
    placed++;
  };
  if (deck.key !== 'mini') {
    for (const slot of preferredProjectSlots(deck)) {
      if (placed >= projects.length) break;
      if (!slots.has(slot)) place(slot);
    }
    outer: for (let row = 0; row < deck.rows; row++) {
      for (let col = 0; col < deck.cols; col++) {
        if (placed >= projects.length) break outer;
        const slot = `${col},${row}`;
        if (slots.has(slot)) continue;
        place(slot);
      }
    }
  }

  fillEmptySlots(slots, deck);
  const manifest: Record<string, unknown> = {
    Actions: Object.fromEntries(slots),
    // The exact connected hardware's code when the caller sniffed one (see detectDeviceModel) —
    // a family default here can refuse to import onto a revision device (e.g. an XL 20GAT9902).
    DeviceModel: deviceModel,
    Name: 'Jetstream',
    Version: '1.0',
  };
  return { manifest, placedProjects: placed, skippedProjects: projects.length - placed };
}

/** Stable .sdProfile dir names for the SHIPPED default profiles, so the packaged
 * plugin is byte-reproducible across builds. */
export const DEFAULT_PROFILE_IDS: Record<DeckModel['key'], string> = {
  mini: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AA001',
  standard: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AA002',
  xl: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AA003',
};

/** Stable ids for the shipped OPS (second-page) profiles. The Mini has no Ops page (too few
 * keys for two pages), so its id is unused — kept so the map is total. */
export const OPS_PROFILE_IDS: Record<DeckModel['key'], string> = {
  mini: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AB001',
  standard: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AB002',
  xl: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AB003',
};

/** Stable ids for the bundled GRID overlay profiles (the coordinate reference you toggle to). */
export const GRID_PROFILE_IDS: Record<DeckModel['key'], string> = {
  mini: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AC001',
  standard: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AC002',
  xl: '7A2B60D1-4E63-4B5A-9C1D-1B4E9A0AC003',
};

/** The profile file name (and manifest display name) per device, mirroring the
 * tutorial plugin's convention ("Tutorial" / "Tutorial Mini" / "Tutorial XL"). */
export function defaultProfileName(deck: DeckModel): string {
  if (deck.key === 'xl') return 'Jetstream XL';
  if (deck.key === 'mini') return 'Jetstream Mini';
  return 'Jetstream';
}

/** The OPS (second-page) profile name per device — mirrors defaultProfileName with " Ops"
 * inserted, matching a manifest `Profiles[].Name` so switchToProfile accepts it. */
export function opsProfileName(deck: DeckModel): string {
  if (deck.key === 'xl') return 'Jetstream Ops XL';
  if (deck.key === 'mini') return 'Jetstream Ops Mini';
  return 'Jetstream Ops';
}

/** The bundled GRID overlay profile name per device — must match a manifest `Profiles[].Name`
 * so a Grid key can `switchToProfile` to it. */
export function gridProfileName(deck: DeckModel): string {
  if (deck.key === 'xl') return 'Jetstream Grid XL';
  if (deck.key === 'mini') return 'Jetstream Grid Mini';
  return 'Jetstream Grid';
}

/** DeviceType (Stream Deck SDK enum) → DeckModel key for the three decks we bundle a
 * profile for. Standard=0, Mini=1, XL=2; every other device (Stream Deck +, Pedal, …)
 * has no bundled profile. */
const DEVICE_TYPE_KEY: Record<number, DeckModel['key']> = { 0: 'standard', 1: 'mini', 2: 'xl' };

/** The DeckModel for a connected device's DeviceType, or `undefined` when we ship no layout
 * for it (Stream Deck +, Pedal, …). Lets the in-app "Build my layout" generate the right
 * personalized profile per connected device. */
export function deckForDeviceType(type: number): DeckModel | undefined {
  const key = DEVICE_TYPE_KEY[type];
  return key ? DECK_MODELS.find((d) => d.key === key) : undefined;
}

/** The bundled profile name (matching a manifest `Profiles[].Name`, e.g. `profiles/Jetstream`)
 * for a connected device's DeviceType, or `undefined` when no profile ships for it. Used by
 * the in-app "Switch to Jetstream layout" button — the only caller of `switchToProfile`,
 * which requires a name identical to the manifest's. */
export function profileForDeviceType(type: number): string | undefined {
  const deck = deckForDeviceType(type);
  return deck ? `profiles/${defaultProfileName(deck)}` : undefined;
}

/**
 * The DEFAULT profile that ships WITH the plugin (manifest `Profiles` array): the same
 * fixed board as init's, with the preferred project slots as UNCONFIGURED invitation
 * keys (they render "set path" until the user fills them via the Property Inspector) —
 * a bundled profile is baked at publish time, so it can carry no user data. Everything
 * else on it works with zero configuration.
 */
export function buildDefaultProfile(deck: DeckModel): BuiltProfile {
  const slots = fixedLayout(deck);
  const invitations = preferredProjectSlots(deck);
  for (const slot of invitations) {
    slots.set(slot, action('Project status', 'gg.pim.jetstream.project'));
  }
  fillEmptySlots(slots, deck);
  const name = defaultProfileName(deck);
  const manifest: Record<string, unknown> = {
    Actions: Object.fromEntries(slots),
    DeviceModel: deck.model,
    Name: name,
    // Plugin-bundled profiles (declared in manifest.Profiles) carry these so the app
    // associates the profile with the plugin and cleans it up on uninstall — Elgato's
    // own bundled profiles do. PreconfiguredName mirrors the manifest Profiles[].Name.
    // NOT set on buildProfile: that's a user-imported (double-click) profile, which
    // isn't plugin-preinstalled and must not be stamped as installed-by-plugin.
    InstalledByPluginUUID: 'gg.pim.jetstream',
    PreconfiguredName: `profiles/${name}`,
    Version: '1.0',
  };
  return { manifest, placedProjects: 0, skippedProjects: 0 };
}

/** The OPS (second) page: the control/action keys that don't fit the status board — the model
 * toggle, stop-all, a strip of Launch invitation keys, and a nav key back to the board. Standard +
 * XL only (the Mini has no room for a second page). Everything works with zero config except the
 * Launch keys (invitations). */
function fixedOpsLayout(deck: DeckModel): Map<string, ProfileAction> {
  const slots = new Map<string, ProfileAction>();
  const at = (col: number, row: number, entry: ProfileAction): void => {
    slots.set(`${col},${row}`, entry);
  };
  at(0, 0, action('Page: Board', 'gg.pim.jetstream.nav', { target: 'board' } satisfies NavSettings));
  at(deck.cols - 1, 0, action('Stop all', 'gg.pim.jetstream.interruptall'));
  at(deck.cols - 1, deck.rows - 1, action('Jetstream settings', 'gg.pim.jetstream.settings'));
  return slots;
}

/**
 * The bundled OPS profile (manifest `Profiles` array): the controls page of the two-page
 * deck. Baked at publish time, so it carries no user data — every key on it is zero-config
 * (page nav, stop-all, settings); the rest of the page is left empty for `jetstream chat` to
 * fill with your own shortcuts. Standard + XL only.
 */
export function buildOpsProfile(deck: DeckModel): BuiltProfile {
  const name = opsProfileName(deck);
  const slots = fixedOpsLayout(deck);
  fillEmptySlots(slots, deck);
  const manifest: Record<string, unknown> = {
    Actions: Object.fromEntries(slots),
    DeviceModel: deck.model,
    Name: name,
    InstalledByPluginUUID: 'gg.pim.jetstream',
    PreconfiguredName: `profiles/${name}`,
    Version: '1.0',
  };
  return { manifest, placedProjects: 0, skippedProjects: 0 };
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (STORE only). A .streamDeckProfile is a plain zip of a
// `<uuid>.sdProfile/` folder holding manifest.json; uncompressed entries keep
// this dependency-free (the archive is ~2 KB) and byte-deterministic.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string; // '/'-terminated names are directories
  data: Buffer;
}

/** Build a STORE-only zip: local headers + central directory + EOCD. Timestamps are
 * pinned to the DOS epoch (1980-01-01) so the same input always yields the same bytes. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.data.length ? crc32(entry.data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size (= raw for STORE)
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra/comment/disk/internal attrs all zero (30..37)
    central.writeUInt32LE(entry.name.endsWith('/') ? 0x10 : 0, 38); // external attrs: dir bit
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** Render a built profile into .streamDeckProfile bytes. `id` (the .sdProfile dir name)
 * is injectable so tests get deterministic archives. */
export function renderProfileArchive(built: BuiltProfile, id: string = randomUUID()): Buffer {
  const dir = `${id.toUpperCase()}.sdProfile/`;
  return buildZip([
    { name: dir, data: Buffer.alloc(0) },
    { name: `${dir}manifest.json`, data: Buffer.from(JSON.stringify(built.manifest), 'utf8') },
  ]);
}

/** Build + write a Jetstream .streamDeckProfile for `deck`. Returns the placement tally. */
export function writeProfileFile(
  outPath: string,
  deck: DeckModel,
  projects: ProjectConfig[],
  // Sniff the connected hardware's exact revision by default so the generated profile can
  // actually import onto it; injectable so tests stay machine-independent.
  deviceModel: string = detectDeviceModel(deck),
): BuiltProfile {
  const built = buildProfile(deck, projects, deviceModel);
  writeFileSync(outPath, renderProfileArchive(built));
  return built;
}

/** The bundled GRID overlay profile: a coordinate key on EVERY slot. A "Grid" key toggles the
 * deck to this via `switchToProfile` (it's plugin-bundled, like Board/Ops), and pressing any key
 * on it returns to your board — so you see the a1…hN reference without importing anything. */
export function buildGridProfile(deck: DeckModel, model: string = deck.model): BuiltProfile {
  const slots = new Map<string, ProfileAction>();
  for (let row = 0; row < deck.rows; row++) {
    for (let col = 0; col < deck.cols; col++) {
      slots.set(`${col},${row}`, action('Grid coordinate', 'gg.pim.jetstream.coord'));
    }
  }
  const name = gridProfileName(deck);
  const manifest: Record<string, unknown> = {
    Actions: Object.fromEntries(slots),
    DeviceModel: model,
    Name: name,
    InstalledByPluginUUID: 'gg.pim.jetstream',
    PreconfiguredName: `profiles/${name}`,
    Version: '1.0',
  };
  return { manifest, placedProjects: 0, skippedProjects: 0 };
}

/** A CUSTOM layout profile from the chat designer: place each resolved key (a Jetstream key or a
 * built-in Elgato Open/Website/Text/Hotkey) at its coordinate. Same importable V1 shape as the
 * other generators — the `action()` helper's output is exactly a placed V1 action. */
export function buildLayoutProfile(
  deck: DeckModel,
  placements: Placement[],
  model: string = deck.model,
): BuiltProfile {
  const slots = new Map<string, ProfileAction>();
  for (const p of placements) {
    slots.set(`${p.column},${p.row}`, action(p.name, p.uuid, p.settings));
  }
  fillEmptySlots(slots, deck);
  const manifest: Record<string, unknown> = {
    Actions: Object.fromEntries(slots),
    DeviceModel: model,
    Name: 'Jetstream Custom',
    Version: '1.0',
  };
  return { manifest, placedProjects: 0, skippedProjects: 0 };
}
