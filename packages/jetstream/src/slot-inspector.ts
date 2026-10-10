import { isAbsolute } from 'node:path';
import type { SlotSettings } from './actions/slot';
import { normalizeColor } from './slot-color';
import { isHttpUrl, isSafeAppTarget, parseSlotCommand, sameSlot } from './slot-command';

/** `field` names the form input an error is about, so the inspector can mark and focus it. */
type EditResult = { ok: true; settings: SlotSettings } | { ok: false; error: string; field?: 'target' | 'color' };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Merge only fields owned by the form. Hidden settings must survive cosmetic edits. */
export function editSlot(current: SlotSettings, expected: unknown, edit: unknown): EditResult {
  if (!isRecord(expected) || !sameSlot(current, expected)) {
    return { ok: false, error: 'This slot changed. Choose Cancel to load its current settings, then edit again.' };
  }
  const currentKind = current.kind ?? 'empty';
  const isBasic = ['empty', 'app', 'url', 'project'].includes(currentKind);
  if (currentKind === 'run' || currentKind === 'stopall' ||
      (!isBasic && !parseSlotCommand({ coord: 'a1', ...current, kind: currentKind }))) {
    return { ok: false, error: "You can't change this key here. To change it, run jetstream chat in Terminal." };
  }
  if (!isRecord(edit) || Object.keys(edit).some((key) => !['kind', 'target', 'label', 'color'].includes(key)) ||
      !['kind', 'target', 'label', 'color'].every((key) => Object.hasOwn(edit, key) && typeof edit[key] === 'string')) {
    return { ok: false, error: 'Jetstream did not understand this edit. Click another key, then click this key again.' };
  }
  const { kind, target, label, color } = edit as Record<'kind' | 'target' | 'label' | 'color', string>;
  if (!['empty', 'app', 'url', 'project', currentKind].includes(kind)) {
    return { ok: false, error: 'Choose Empty, App or folder, URL, or Project.' };
  }
  const next = { ...current, kind: kind as SlotSettings['kind'] };
  if (kind !== currentKind) {
    for (const field of ['app', 'url', 'path', 'name', 'provider'] as const) delete next[field];
  }
  const value = target.trim();
  if (kind === 'app' || kind === 'project') {
    if (!isAbsolute(value) || !isSafeAppTarget(value)) {
      return { ok: false, error: 'Enter a full path, such as /Applications/Telegram.app or /Users/you/project.', field: 'target' };
    }
    if (kind === 'app') next.app = value;
    else {
      // The hidden name belongs to the old folder; without it the key and roll-ups use the new folder's name.
      if (value !== current.path) delete next.name;
      next.path = value;
    }
  } else if (kind === 'url') {
    if (!isHttpUrl(value)) return { ok: false, error: 'Enter a complete http:// or https:// URL.', field: 'target' };
    next.url = value;
  }
  const normalized = color.trim() ? normalizeColor(color) : undefined;
  if (color.trim() && typeof normalized !== 'string') {
    return { ok: false, error: 'Use a colour name such as blue, or a hex colour such as #0091ff.', field: 'color' };
  }
  if (label.trim()) next.label = label.trim();
  else delete next.label;
  if (normalized) next.color = normalized;
  else delete next.color;
  if (kind === 'empty') {
    for (const field of ['label', 'color', 'icon', 'sub', 'glyph'] as const) delete next[field];
  }
  return { ok: true, settings: next };
}
