/**
 * Every Stream Deck action this plugin implements, as plain data (DECISIONS.md 2026-07-25 #6).
 * action-registry.ts pairs one instance with each entry through a Record keyed by this list, so the
 * compiler refuses a missing registration and its test checks each instance's uuid; profile.test.ts
 * checks the list against the manifest and the `@action` decorators. Listing a uuid next to its class
 * is redundant on purpose: that is what makes the three surfaces checkable without booting the SDK in
 * a test.
 */
export const ACTION_UUIDS = [
  'gg.pim.jetstream.project',
  'gg.pim.jetstream.fleet',
  'gg.pim.jetstream.attention',
  'gg.pim.jetstream.usage',
  'gg.pim.jetstream.permission',
  'gg.pim.jetstream.settings',
  'gg.pim.jetstream.nav',
  'gg.pim.jetstream.build',
  'gg.pim.jetstream.coord',
  'gg.pim.jetstream.grid',
  'gg.pim.jetstream.slot',
  'gg.pim.jetstream.micmute',
  'gg.pim.jetstream.interruptall',
  'gg.pim.jetstream.dial',
] as const;

export type ActionUuid = (typeof ACTION_UUIDS)[number];
