import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { ProjectConfig } from '@pimmesz/jetstream-status';
import type { PermissionSettings } from './actions/permission';
import type { ProjectSettings } from './actions/project';

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

export interface BuiltProfile {
  /** The profile manifest, ready to stringify. */
  manifest: Record<string, unknown>;
  /** How many project keys made it onto the grid. */
  placedProjects: number;
  /** Projects that didn't fit (or the deck has no room for project keys at all). */
  skippedProjects: number;
}

/** The fixed keys every Jetstream board shares (both the shipped default and init's
 * personalized layout — same slots, so upgrading feels like filling in the same board):
 * Fleet/Attention/Usage top-left, Approve/Deny top-right (stacked on row 1 for the
 * Mini), Settings bottom-right, CI where there's room, one Launch teaching slot on the
 * XL. Returns the slot map plus the moat — deliberately-empty keys that separate the
 * watch strip from the blind-reach Approve/Deny pair; project keys never fill them. */
function fixedLayout(deck: DeckModel): { slots: Map<string, ProfileAction>; moat: Set<string> } {
  const slots = new Map<string, ProfileAction>();
  const moat = new Set<string>();
  const at = (col: number, row: number, entry: ProfileAction): void => {
    slots.set(`${col},${row}`, entry);
  };

  at(0, 0, action('Fleet roll-up', 'gg.pim.jetstream.fleet'));
  at(1, 0, action('Attention', 'gg.pim.jetstream.attention'));
  at(2, 0, action('Usage gauge', 'gg.pim.jetstream.usage'));
  // The literals are type-checked against the actions' OWN settings types, so a
  // renamed field breaks the build here instead of shipping a dead key.
  const allow = { decision: 'allow' } satisfies PermissionSettings;
  const deny = { decision: 'deny' } satisfies PermissionSettings;
  if (deck.key === 'mini') {
    // 6 keys: the fleet covers every repo, so the Mini gets the essentials only.
    at(0, 1, action('Approve', 'gg.pim.jetstream.permission', allow));
    at(1, 1, action('Deny', 'gg.pim.jetstream.permission', deny));
    at(2, 1, action('Jetstream settings', 'gg.pim.jetstream.settings'));
  } else {
    at(deck.cols - 2, 0, action('Approve', 'gg.pim.jetstream.permission', allow));
    at(deck.cols - 1, 0, action('Deny', 'gg.pim.jetstream.permission', deny));
    at(deck.cols - 1, deck.rows - 1, action('Jetstream settings', 'gg.pim.jetstream.settings'));
    // CI fits on row 0 only when Approve/Deny don't already crowd it (the XL).
    if (deck.cols >= 8) {
      at(3, 0, action('CI / PR status', 'gg.pim.jetstream.ci'));
      // One teaching slot for the headless-launch capability; bottom edge.
      at(0, deck.rows - 1, action('Launch preset', 'gg.pim.jetstream.launch'));
      // Row-0 gap between the watch strip (cols 0-3) and the decide pair (cols 6-7).
      moat.add('4,0');
      moat.add('5,0');
    } else {
      at(0, deck.rows - 1, action('CI / PR status', 'gg.pim.jetstream.ci'));
    }
  }
  return { slots, moat };
}

/** Where project keys go first: a centered middle-rows block (the deck-ergonomics
 * convention — content blocks sit centered with whitespace around them, and six slots
 * match a realistic hot-repo count). Overflow spills row-major into other free slots. */
function preferredProjectSlots(deck: DeckModel): string[] {
  if (deck.key === 'xl') return ['2,1', '3,1', '4,1', '2,2', '3,2', '4,2'];
  if (deck.key === 'standard') return ['1,1', '2,1', '3,1'];
  return [];
}

/**
 * Lay out the personalized Jetstream board (`jetstream init`): the shared fixed keys
 * plus Project keys (name+path prefilled) — preferred centered slots first, then any
 * remaining free slot row-major (never the moat). Pure.
 */
export function buildProfile(deck: DeckModel, projects: ProjectConfig[]): BuiltProfile {
  const { slots, moat } = fixedLayout(deck);

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
        if (slots.has(slot) || moat.has(slot)) continue;
        place(slot);
      }
    }
  }

  const manifest: Record<string, unknown> = {
    Actions: Object.fromEntries(slots),
    DeviceModel: deck.model,
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

/** The profile file name (and manifest display name) per device, mirroring the
 * tutorial plugin's convention ("Tutorial" / "Tutorial Mini" / "Tutorial XL"). */
export function defaultProfileName(deck: DeckModel): string {
  if (deck.key === 'xl') return 'Jetstream XL';
  if (deck.key === 'mini') return 'Jetstream Mini';
  return 'Jetstream';
}

/** DeviceType (Stream Deck SDK enum) → DeckModel key for the three decks we bundle a
 * profile for. Standard=0, Mini=1, XL=2; every other device (Stream Deck +, Pedal, …)
 * has no bundled profile. */
const DEVICE_TYPE_KEY: Record<number, DeckModel['key']> = { 0: 'standard', 1: 'mini', 2: 'xl' };

/** The bundled profile name (matching a manifest `Profiles[].Name`, e.g. `profiles/Jetstream`)
 * for a connected device's DeviceType, or `undefined` when no profile ships for it. Used by
 * the in-app "Switch to Jetstream layout" button — the only caller of `switchToProfile`,
 * which requires a name identical to the manifest's. */
export function profileForDeviceType(type: number): string | undefined {
  const key = DEVICE_TYPE_KEY[type];
  if (!key) return undefined;
  const deck = DECK_MODELS.find((d) => d.key === key);
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
  const { slots } = fixedLayout(deck);
  const invitations = preferredProjectSlots(deck);
  for (const slot of invitations) {
    slots.set(slot, action('Project status', 'gg.pim.jetstream.project'));
  }
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
): BuiltProfile {
  const built = buildProfile(deck, projects);
  writeFileSync(outPath, renderProfileArchive(built));
  return built;
}
