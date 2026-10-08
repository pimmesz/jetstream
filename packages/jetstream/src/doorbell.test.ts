import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted knobs the mocks read, so a test can set what is waiting and since when.
const h = vi.hoisted(() => ({
  waiting: [] as Array<{ id: string; name: string; path: string }>,
  byProject: {} as Record<string, { status: string; since?: number }>,
}));
vi.mock('./state', () => ({ board: { attention: () => h.waiting, byProject: () => h.byProject } }));
vi.mock('./config', () => ({ config: { get: () => ({ longPressMs: 1000, escalateAfterSec: 60, theme: 'default' }) } }));

import { Doorbell, doorbellFace, type DoorbellInput } from './doorbell';

const input = (over: Partial<DoorbellInput>): DoorbellInput => ({
  waiting: [{ id: 'falcon', name: 'Falcon' }],
  headStatus: 'needsInput',
  snoozed: false,
  escalate: false,
  flashOn: false,
  theme: 'default',
  ...over,
});

describe('doorbellFace', () => {
  it('is calm and grey with nothing waiting', () => {
    expect(doorbellFace(input({ waiting: [] }))).toEqual({ color: '#26262b', label: 'all clear' });
  });

  it('a waiting turn is amber "needs you"; a died turn is magenta "failed"', () => {
    expect(doorbellFace(input({}))).toMatchObject({ color: '#ffb224', label: 'Falcon', sub: 'needs you' });
    expect(doorbellFace(input({ headStatus: 'failed' }))).toMatchObject({ label: 'Falcon', sub: 'failed' });
    expect(doorbellFace(input({ headStatus: 'failed' })).color).not.toBe('#ffb224');
  });

  it('several waiting show +N; snoozed and escalated say so, in that priority', () => {
    const two = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    expect(doorbellFace(input({ waiting: two, snoozed: true, escalate: true })).sub).toBe('+1 more');
    expect(doorbellFace(input({ snoozed: true, escalate: true })).sub).toBe('snoozed');
    expect(doorbellFace(input({ escalate: true })).sub).toBe('still waiting');
    expect(doorbellFace(input({ escalate: true, headStatus: 'failed' })).sub).toBe('still failed');
  });

  it('an escalated flash alternates colours for both a waiting and a failed head', () => {
    const on = (headStatus: DoorbellInput['headStatus']) => doorbellFace(input({ escalate: true, flashOn: true, headStatus })).color;
    const off = (headStatus: DoorbellInput['headStatus']) => doorbellFace(input({ escalate: true, flashOn: false, headStatus })).color;
    expect(on('needsInput')).not.toBe(off('needsInput'));
    expect(on('failed')).not.toBe(off('failed')); // a constant colour would make the flash invisible
  });
});

describe('Doorbell', () => {
  const T = 1_000_000;
  const LATE = T + 61_000; // past the 60 s escalation
  const falcon = { id: 'falcon', name: 'Falcon', path: '/dev/falcon' };
  beforeEach(() => {
    vi.useFakeTimers();
    h.waiting = [falcon];
    h.byProject = { falcon: { status: 'needsInput', since: T } };
  });
  afterEach(() => vi.useRealTimers());

  it('a long press snoozes: the face says so, the flash stops, and the keys repaint at once', () => {
    const bell = new Doorbell();
    const onFrame = vi.fn();
    bell.onFrame = onFrame;
    expect(bell.face(LATE).sub).toBe('still waiting');
    vi.advanceTimersByTime(2000);
    expect(onFrame).toHaveBeenCalledTimes(2); // flashing, one frame a second
    expect(bell.press(1500, LATE)).toEqual({ act: 'snooze' });
    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(bell.face(LATE + 1).sub).toBe('snoozed');
    vi.advanceTimersByTime(5000);
    expect(onFrame).toHaveBeenCalledTimes(3); // no flash frames while snoozed
  });

  it('a short tap jumps to the neediest project and does not snooze', () => {
    const bell = new Doorbell();
    expect(bell.press(200, LATE)).toEqual({ act: 'jump', path: '/dev/falcon' });
    expect(bell.face(LATE + 1).sub).toBe('still waiting');
  });

  it('an all clear ends the snooze, so the next wait alerts fresh', () => {
    const bell = new Doorbell();
    bell.press(1500, T);
    expect(bell.face(T + 1).sub).toBe('snoozed');
    h.waiting = [];
    expect(bell.face(T + 2).label).toBe('all clear');
    h.waiting = [falcon];
    expect(bell.face(T + 3).sub).toBe('needs you');
  });
});
