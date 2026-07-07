import { describe, it, expect } from 'vitest';
import { Board } from './state';

describe('Board', () => {
  it('maps hook events onto registered project keys', () => {
    const board = new Board();
    board.setProject('key-1', { name: 'falcon', path: '/Users/me/falcon' });
    board.dispatch({ event: 'UserPromptSubmit', cwd: '/Users/me/falcon/src', sessionId: 's1', at: 5 });
    expect(board.byProject()['key-1']).toEqual({ status: 'working', since: 5 });
  });

  it('attention lists waiting projects and clears on key removal', () => {
    const board = new Board();
    board.setProject('key-1', { name: 'falcon', path: '/Users/me/falcon' });
    board.dispatch({ event: 'Notification', cwd: '/Users/me/falcon', sessionId: 's1', at: 5 });
    expect(board.attention().map((p) => p.name)).toEqual(['falcon']);
    board.removeProject('key-1');
    expect(board.attention()).toEqual([]);
  });

  it('notifies subscribers on dispatch and settings changes', () => {
    const board = new Board();
    let calls = 0;
    board.subscribe(() => calls++);
    board.setProject('k', { name: 'x', path: '/x' });
    board.dispatch({ event: 'Stop', cwd: '/x', sessionId: 's', at: 1 });
    expect(calls).toBe(2);
  });
});
