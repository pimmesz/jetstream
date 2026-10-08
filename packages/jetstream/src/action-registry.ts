import type streamDeck from '@elgato/streamdeck';
import type { ActionUuid } from './action-uuids';
import { ProjectKey } from './actions/project';
import { AttentionKey } from './actions/attention';
import { FleetKey } from './actions/fleet';
import { UsageKey } from './actions/usage';
import { PermissionKey } from './actions/permission';
import { SettingsKey } from './actions/settings';
import { FleetDialKey } from './actions/dial';
import { InterruptAllKey } from './actions/interrupt-all';
import { NavKey } from './actions/nav';
import { BuildKey } from './actions/build';
import { CoordinateKey } from './actions/coord';
import { GridKey } from './actions/grid';
import { SlotKey } from './actions/slot';
import { MicMuteKey } from './actions/micmute';

/** The one instance of each action. Kept out of plugin.ts (which boots the SDK) so a test can check
 * that every instance sits under its own uuid. */
export const projectKey = new ProjectKey();
export const attentionKey = new AttentionKey();
export const fleetKey = new FleetKey();
export const usageKey = new UsageKey();
export const permissionKey = new PermissionKey();
export const settingsKey = new SettingsKey();
export const fleetDialKey = new FleetDialKey();
export const interruptAllKey = new InterruptAllKey();
export const slotKey = new SlotKey();
export const micMuteKey = new MicMuteKey();

// Keyed by ACTION_UUIDS, so leaving an action out does not compile. The SDK routes on the instance's own
// manifestId, so a wrong instance under a key would bind one action twice and leave another dead.
export const registry: Record<ActionUuid, Parameters<typeof streamDeck.actions.registerAction>[0]> = {
  'gg.pim.jetstream.project': projectKey,
  'gg.pim.jetstream.fleet': fleetKey,
  'gg.pim.jetstream.attention': attentionKey,
  'gg.pim.jetstream.usage': usageKey,
  'gg.pim.jetstream.permission': permissionKey,
  'gg.pim.jetstream.settings': settingsKey,
  'gg.pim.jetstream.nav': new NavKey(),
  'gg.pim.jetstream.build': new BuildKey(),
  'gg.pim.jetstream.coord': new CoordinateKey(),
  'gg.pim.jetstream.grid': new GridKey(),
  'gg.pim.jetstream.slot': slotKey,
  'gg.pim.jetstream.micmute': micMuteKey,
  'gg.pim.jetstream.interruptall': interruptAllKey,
  'gg.pim.jetstream.dial': fleetDialKey,
};
