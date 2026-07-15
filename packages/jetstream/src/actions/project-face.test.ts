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

  it('needsInput → ! + approve? when deck-answerable, ? + answer otherwise', () => {
    expect(projectFace({ ...base, name: 'x', configured: true, status: 'needsInput', answerable: true })).toMatchObject({
      glyph: '!',
      sub: 'approve?',
    });
    expect(projectFace({ ...base, name: 'x', configured: true, status: 'needsInput', answerable: false })).toMatchObject({
      glyph: '?',
      sub: 'answer',
    });
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
});
