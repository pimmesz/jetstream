import { describe, it, expect } from 'vitest';
import { ACTION_UUIDS } from './action-uuids';
import { registry } from './action-registry';

describe('action registry', () => {
  it('registers every action under its own uuid, so none is bound twice and none is left dead', () => {
    for (const uuid of ACTION_UUIDS) expect(registry[uuid].manifestId, uuid).toBe(uuid);
  });
});
