import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CiState } from '../ci-status';

vi.mock('../state', () => ({ board: { projects: () => [] } }));
vi.mock('../config', () => ({ config: { get: () => ({ ciBranchPrefix: 'afterburner/' }) } }));
vi.mock('../ci-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ci-status')>()),
  pollFleetCi: vi.fn(),
}));

import { pollFleetCi } from '../ci-status';
import { CiKey } from './ci';

beforeEach(() => vi.mocked(pollFleetCi).mockReset());

describe('CiKey.refresh', () => {
  it('coalesces overlapping refreshes into a single gh fan-out (single-flight)', async () => {
    const ci = new CiKey();
    vi.spyOn(ci as unknown as { hasKey(): boolean }, 'hasKey').mockReturnValue(true);
    vi.spyOn(ci, 'renderAll').mockResolvedValue();

    let release!: (v: CiState) => void;
    const gate = new Promise<CiState>((r) => (release = r));
    vi.mocked(pollFleetCi).mockReturnValueOnce(gate).mockResolvedValue('passing');

    const a = ci.refresh(); // starts the poll, blocks on the gate
    const b = ci.refresh(); // must share the in-flight poll, not start a second fan-out
    expect(pollFleetCi).toHaveBeenCalledTimes(1);

    release('passing');
    await Promise.all([a, b]);
    expect(pollFleetCi).toHaveBeenCalledTimes(1);

    await ci.refresh(); // in-flight cleared → a fresh poll runs
    expect(pollFleetCi).toHaveBeenCalledTimes(2);
  });
});
