import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  matchProject,
  reduce,
  initialState,
  statusByProject,
  needsAttention,
  colorFor,
  type HookEvent,
  type ProjectConfig,
} from './index';

const PROJECTS: ProjectConfig[] = [
  { id: 'falcon', name: 'Falcon', path: '/Users/me/falcon' },
  { id: 'osprey', name: 'Osprey', path: '/Users/me/osprey' },
  { id: 'ab', name: 'Afterburner', path: '/Users/me/afterburner' },
];

const ev = (over: Partial<HookEvent>): HookEvent => ({
  event: 'UserPromptSubmit',
  cwd: '/Users/me/falcon',
  sessionId: 's1',
  at: 1000,
  ...over,
});

describe('parseHookPayload', () => {
  it('parses a valid hook payload', () => {
    expect(
      parseHookPayload(
        { hook_event_name: 'Stop', cwd: '/Users/me/falcon', session_id: 'abc' },
        5,
      ),
    ).toEqual({ event: 'Stop', cwd: '/Users/me/falcon', sessionId: 'abc', at: 5 });
  });

  it('rejects unknown events and malformed payloads', () => {
    expect(parseHookPayload({ hook_event_name: 'Nope', cwd: '/x', session_id: 'a' }, 1)).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'Stop', session_id: 'a' }, 1)).toBeNull();
    expect(parseHookPayload(null, 1)).toBeNull();
    expect(parseHookPayload('nope', 1)).toBeNull();
  });
});

describe('matchProject', () => {
  it('matches by path and picks the longest prefix for nested projects', () => {
    expect(matchProject('/Users/me/falcon', PROJECTS)).toBe('falcon');
    expect(matchProject('/Users/me/falcon/src/deep', PROJECTS)).toBe('falcon');
    expect(matchProject('/Users/me/elsewhere', PROJECTS)).toBeUndefined();
    const nested = [
      { id: 'root', name: 'r', path: '/Users/me' },
      { id: 'falcon', name: 'h', path: '/Users/me/falcon' },
    ];
    expect(matchProject('/Users/me/falcon/x', nested)).toBe('falcon');
  });

  it("does not match a sibling that shares a name prefix", () => {
    expect(matchProject('/Users/me/falcon-two', PROJECTS)).toBeUndefined();
  });
});

describe('reduce + statusByProject', () => {
  it('maps the lifecycle to colours per project', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'SessionStart', sessionId: 'h1', at: 1 })); // falcon idle
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 2 })); // falcon working
    s = reduce(s, ev({ event: 'Stop', cwd: '/Users/me/osprey', sessionId: 'j1', at: 3 })); // osprey done
    s = reduce(s, ev({ event: 'Notification', cwd: '/Users/me/afterburner', sessionId: 'a1', at: 4 })); // ab needsInput

    const by = statusByProject(s, PROJECTS);
    expect(by.falcon).toEqual({ status: 'working', since: 2 });
    expect(by.osprey).toEqual({ status: 'done', since: 3 });
    expect(by.ab).toEqual({ status: 'needsInput', since: 4 });
  });

  it('SessionEnd forgets the session (back to none)', () => {
    let s = reduce(initialState(), ev({ event: 'UserPromptSubmit', sessionId: 'h1' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('working');
    s = reduce(s, ev({ event: 'SessionEnd', sessionId: 'h1' }));
    expect(statusByProject(s, PROJECTS).falcon?.status).toBe('none');
  });

  it('aggregates multiple sessions by priority (needsInput wins) with earliest since', () => {
    let s = initialState();
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1', at: 10 }));
    s = reduce(s, ev({ event: 'Notification', sessionId: 'h2', at: 20 }));
    expect(statusByProject(s, PROJECTS).falcon).toEqual({ status: 'needsInput', since: 20 });
  });
});

describe('needsAttention', () => {
  it('lists projects waiting on the user', () => {
    let s = reduce(initialState(), ev({ event: 'Notification', cwd: '/Users/me/afterburner', sessionId: 'a1' }));
    s = reduce(s, ev({ event: 'UserPromptSubmit', sessionId: 'h1' }));
    expect(needsAttention(s, PROJECTS)).toEqual(['ab']);
  });
});

describe('colorFor', () => {
  it('is defined for every status', () => {
    for (const status of ['none', 'idle', 'working', 'needsInput', 'done'] as const) {
      expect(colorFor(status)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
