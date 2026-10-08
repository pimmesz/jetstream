import { describe, it, expect, vi, beforeEach } from 'vitest';
// Every key that opens a project must go through the run gate, never straight to the opener.
vi.mock('../switchto', async (orig) => ({
  ...(await orig<typeof import('../switchto')>()),
  openProject: vi.fn(() => true),
  openProjectFromKey: vi.fn(async () => true),
}));
import { openProject, openProjectFromKey } from '../switchto';
import { board } from '../state';
import { doorbell } from '../doorbell';
import { FleetDialKey } from './dial';
import { ProjectKey } from './project';
import { SlotKey } from './slot';

const action = (id: string) => ({ id, showAlert: vi.fn(async () => {}), showOk: vi.fn(async () => {}) });

describe('project openers go through the run gate', () => {
  beforeEach(() => {
    vi.mocked(openProject).mockClear();
    vi.mocked(openProjectFromKey).mockClear();
  });

  it('the standalone Project key', async () => {
    board.setProject('proj-key-1', { name: 'api', path: '/repos/api' });
    try {
      await new ProjectKey().onKeyUp({ action: action('proj-key-1'), payload: { settings: {} } } as unknown as Parameters<ProjectKey['onKeyUp']>[0]);
      expect(openProjectFromKey).toHaveBeenCalledWith('/repos/api');
      expect(openProject).not.toHaveBeenCalled();
    } finally {
      board.removeProject('proj-key-1');
    }
  });

  it('the Fleet dial, on a push and on a tap', async () => {
    board.setProject('dial-proj-1', { name: 'web', path: '/repos/web' });
    try {
      const dial = new FleetDialKey();
      await dial.onDialUp({ action: action('dial-1') } as unknown as Parameters<FleetDialKey['onDialUp']>[0]);
      await dial.onTouchTap({ action: action('dial-1'), payload: { hold: false } } as unknown as Parameters<FleetDialKey['onTouchTap']>[0]);
      expect(vi.mocked(openProjectFromKey).mock.calls).toEqual([['/repos/web'], ['/repos/web']]);
      expect(openProject).not.toHaveBeenCalled();
    } finally {
      board.removeProject('dial-proj-1');
    }
  });

  it("the attention slot's doorbell jump", async () => {
    const press = vi.spyOn(doorbell, 'press').mockReturnValue({ act: 'jump', path: '/repos/needy' });
    try {
      const ev = { action: action('att-slot-1'), payload: { settings: { kind: 'attention' } } };
      await new SlotKey().onKeyUp(ev as unknown as Parameters<SlotKey['onKeyUp']>[0]);
      expect(openProjectFromKey).toHaveBeenCalledWith('/repos/needy');
      expect(openProject).not.toHaveBeenCalled();
    } finally {
      press.mockRestore();
    }
  });
});
