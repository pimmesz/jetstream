import { describe, it, expect } from 'vitest';
import { projectFace, type ProjectFaceInput } from './project-face';

// The single source of truth for a repo key's face, shared by ProjectKey and the 'project' slot kind.
// These lock the branch LOGIC unique to this module (configured / needsInput / working / done / word);
// the colour + non-needsInput glyph come from @pimmesz/jetstream-status and aren't asserted here.
const base: Omit<ProjectFaceInput, 'name' | 'configured' | 'status'> = {
  theme: 'default',
  now: 1_000_000,
  answerable: false,
  diffStat: null,
};

describe('projectFace', () => {
  it('shows a dark "set path" placeholder when unconfigured (no glyph)', () => {
    const f = projectFace({ ...base, name: 'x', configured: false, status: 'none' });
    expect(f).toMatchObject({ label: 'x', sub: 'set path', color: '#26262b' });
    expect(f.glyph).toBeUndefined();
  });

  // The sub-line now names WHERE to act, and the corner stays empty: on an ordinary state the
  // glyph only repeated the word underneath it, spending the key's one free spot on nothing.
  it('needsInput says where to act, with no corner marker', () => {
    const answerable = projectFace({ ...base, name: 'x', configured: true, status: 'needsInput', answerable: true });
    expect(answerable.sub).toBe('approve on deck');
    expect(answerable.glyph).toBeUndefined();

    const keyboard = projectFace({ ...base, name: 'x', configured: true, status: 'needsInput', answerable: false });
    expect(keyboard.sub).toBe('answer in Claude');
    expect(keyboard.glyph).toBeUndefined();
  });

  it('leaves the corner empty on every ORDINARY state, and marks the exceptions', () => {
    const ordinary = [
      projectFace({ ...base, name: 'x', configured: true, status: 'done', since: base.now - 60_000 }),
      projectFace({ ...base, name: 'x', configured: true, status: 'idle' }),
      projectFace({ ...base, name: 'x', configured: true, status: 'working', since: base.now - 60_000 }),
    ];
    for (const face of ordinary) expect(face.glyph).toBeUndefined();

    // A failure and a stall are alarms — redundancy is right there.
    expect(projectFace({ ...base, name: 'x', configured: true, status: 'failed', since: base.now - 60_000 }).glyph).toBe('✕');
    expect(
      projectFace({ ...base, name: 'x', configured: true, status: 'working', since: base.now - 25 * 60_000 }).glyph,
    ).toContain('⚠');
    // …and a tool line is the one ordinary case where the sub does NOT say "working".
    expect(
      projectFace({ ...base, name: 'x', configured: true, status: 'working', tool: 'Bash', since: base.now - 60_000 }).glyph,
    ).toBe('⋯');
  });

  it('gives a SHORT sub the larger font, and only long lines the small one', () => {
    // render.ts picks 18px when subMax <= 16, 14px above it. A short line should not be shrunk to
    // fit a width it never uses — the sub is the only colour-independent channel on the key.
    expect(projectFace({ ...base, name: 'x', configured: true, status: 'done', since: base.now - 60_000 }).subMax).toBe(16);
    const withBadge = projectFace({
      ...base,
      name: 'x',
      configured: true,
      status: 'done',
      since: base.now - 60_000,
      diffStat: { added: 120, deleted: 40 },
    });
    expect(withBadge.subMax).toBe(20);
  });

  it('working → "tool · elapsed"', () => {
    const f = projectFace({ ...base, name: 'x', configured: true, status: 'working', tool: 'Bash', since: base.now - 125_000 });
    expect(f.sub).toMatch(/^Bash · /);
  });

  it('done → the diff badge when known, else just "done …"', () => {
    const withBadge = projectFace({
      ...base,
      name: 'x',
      configured: true,
      status: 'done',
      since: base.now - 240_000,
      diffStat: { added: 120, deleted: 40 },
    });
    expect(withBadge.sub).toContain('+120/-40');
    const noBadge = projectFace({ ...base, name: 'x', configured: true, status: 'done', since: base.now - 240_000 });
    expect(noBadge.sub).toMatch(/^done /);
  });

  it('a resting status falls back to the plain status word', () => {
    expect(projectFace({ ...base, name: 'x', configured: true, status: 'idle' }).sub).toBe('idle');
  });

  it('working past the stall threshold → warning glyph + "stalled?" sub (not a confident tool line)', () => {
    const f = projectFace({ ...base, name: 'x', configured: true, status: 'working', tool: 'Bash', since: base.now - 25 * 60_000 });
    expect(f.sub).toMatch(/^stalled\? /);
    expect(f.glyph).toContain('⚠'); // the warning marker, not the normal working glyph
  });

  it('working under the stall threshold stays a normal working face', () => {
    const f = projectFace({ ...base, name: 'x', configured: true, status: 'working', tool: 'Bash', since: base.now - 5 * 60_000 });
    expect(f.sub).toMatch(/^Bash · /);
    expect(f.glyph).not.toContain('⚠');
  });

  it('failed says so, with when — never a wordless coloured key', () => {
    // The sub-line is an if-chain plus a label lookup; a status missing from both renders a key
    // with a colour and no words on it, which is unreadable across a room.
    const f = projectFace({ ...base, name: 'x', configured: true, status: 'failed', since: base.now - 240_000 });
    expect(f.sub).toMatch(/^failed /);
    // …and it still reads without the elapsed time, rather than falling through to blank.
    expect(projectFace({ ...base, name: 'x', configured: true, status: 'failed' }).sub).toBe('FAILED');
  });
});
