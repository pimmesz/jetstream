import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripControl } from './fleet';

/**
 * Keys from OTHER Stream Deck plugins (Philips Hue, Focusrite, ...) that already sit on one of the
 * user's profiles. Chat cannot invent a third-party key's settings (a Hue light id only the Hue
 * plugin knows), but it can place a COPY of one the user already configured. The model only ever
 * names a catalogue ref; the uuid, settings and plugin block come from disk, never from the model.
 */
export interface ForeignAction {
  /** Stable handle the model uses, e.g. "philips-hue-power-1". */
  ref: string;
  uuid: string;
  /** Plugin and action, for the model and the plan preview: "Philips Hue power". */
  title: string;
  /** What this copy targets, when its settings say ("Pim bureau - Signe gradient"). */
  target?: string;
  settings: Record<string, unknown> | null;
  plugin: unknown;
  states: unknown;
}

/** Actions owned by Jetstream or built into Stream Deck are placed through their own types, and the
 * onboarding tutorial's keys are not something anyone asks to place. */
const isForeign = (uuid: string): boolean =>
  !uuid.startsWith('gg.pim.jetstream.') &&
  !uuid.startsWith('com.elgato.streamdeck.') &&
  !uuid.startsWith('com.elgato.tutorial.');

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = stripControl(v).trim();
  return s === '' ? undefined : s.slice(0, 60);
};

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The first human-readable field a plugin's settings use for "what this key controls". */
function targetOf(settings: Record<string, unknown> | null): string | undefined {
  if (!settings) return undefined;
  for (const field of ['name', 'title', 'label', 'device', 'deviceName', 'scene', 'light']) {
    const value = clean(settings[field]);
    if (value) return value;
  }
  return undefined;
}

const hasResources = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && Object.keys(v).length > 0;

/** Same uuid and settings means the same key, wherever it was copied. */
export const foreignKey = (uuid: string, settings: unknown): string => `${uuid}\u0000${JSON.stringify(settings ?? null)}`;

/** Every distinct third-party key across every profile and page. Never throws. */
export function readForeignCatalog(profilesDir: string): ForeignAction[] {
  const seen = new Map<string, ForeignAction>();
  const perAction = new Map<string, number>();
  let profiles: string[];
  try {
    profiles = readdirSync(profilesDir).filter((d) => d.endsWith('.sdProfile')).sort();
  } catch {
    return [];
  }
  for (const profile of profiles) {
    const pagesDir = join(profilesDir, profile, 'Profiles');
    if (!existsSync(pagesDir)) continue;
    for (const page of readdirSync(pagesDir).sort()) {
      let parsed: { Controllers?: Array<{ Actions?: Record<string, Record<string, unknown>> }> };
      try {
        parsed = JSON.parse(readFileSync(join(pagesDir, page, 'manifest.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const controller of parsed.Controllers ?? []) {
        for (const action of Object.values(controller.Actions ?? {})) {
          const uuid = typeof action.UUID === 'string' ? action.UUID : '';
          if (!uuid || !isForeign(uuid)) continue;
          // A key with embedded resources (an audio file, say) points at files inside its own profile;
          // a copy would lose them and break, so it is not offered.
          if (hasResources(action.Resources)) continue;
          const settings =
            typeof action.Settings === 'object' && action.Settings !== null && !Array.isArray(action.Settings)
              ? (action.Settings as Record<string, unknown>)
              : null;
          const key = foreignKey(uuid, settings);
          if (seen.has(key)) continue;
          const pluginName = clean((action.Plugin as { Name?: unknown } | null)?.Name) ?? uuid.split('.').slice(0, -1).join('.');
          const actionName = uuid.split('.').pop() ?? uuid;
          const base = slug(`${pluginName}-${actionName}`);
          const n = (perAction.get(base) ?? 0) + 1;
          perAction.set(base, n);
          const target = targetOf(settings);
          seen.set(key, {
            ref: `${base}-${n}`,
            uuid,
            title: `${pluginName} ${actionName}`,
            ...(target ? { target } : {}),
            settings,
            plugin: action.Plugin ?? null,
            states: action.States,
          });
        }
      }
    }
  }
  return [...seen.values()];
}

/** One line per catalogue entry, for the chat model. */
export function describeCatalog(catalog: ForeignAction[]): string[] {
  return catalog.map((c) => `  ${c.ref}: ${c.title}${c.target ? ` (${JSON.stringify(c.target)})` : ''}`);
}
