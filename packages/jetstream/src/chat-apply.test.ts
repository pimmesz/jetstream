import { describe, it, expect, vi } from 'vitest';
import { applyLayout, planLayout, type ApplyDeps } from './chat-apply';
import type { BoardLayout, BoardKey } from './board-layout';
import type { Placement } from './layout';
import { DECK_MODELS } from './profile';

const XL = DECK_MODELS.find((d) => d.key === 'xl')!;
const slot = (settings: Record<string, unknown>, label: string): BoardKey => ({
  uuid: 'gg.pim.jetstream.slot',
  settings,
  label,
});
const board = (keys: Record<string, BoardKey>): BoardLayout => ({
  profileName: 'Jetstream',
  profileDir: '/store/board.sdProfile',
  deck: XL,
  keys: new Map(Object.entries(keys)),
  allUuids: [],
});
const place = (column: number, row: number, uuid: string, settings: Record<string, unknown> | null): Placement => ({
  column,
  row,
  uuid,
  name: 'x',
  settings,
});

function deps(over: Partial<ApplyDeps> = {}): ApplyDeps & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    say: (l) => void said.push(l),
    confirm: async () => true,
    board: null,
    pluginAlive: async () => true,
    sendSlot: async () => 200,
    writeInPlace: vi.fn(async () => ({ ok: true as const, backup: '/bak', removed: [] })),
    importProfile: vi.fn(() => '/Downloads/x.streamDeckProfile'),
    ...over,
  };
}

describe('planLayout', () => {
  it('routes slot-over-slot live, a new native or third-party key to the restart write, and skips no-ops', () => {
    const b = board({
      '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'),
      '1,0': slot({ kind: 'empty' }, '·'),
      '2,0': { uuid: 'gg.pim.jetstream.project', settings: { path: '/r' }, label: 'r' },
    });
    const plan = planLayout(b, [
      place(0, 0, 'gg.pim.jetstream.slot', { kind: 'app', app: '/A.app' }), // unchanged
      place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), // live
      place(2, 0, 'gg.pim.jetstream.slot', { kind: 'project', path: '/r' }), // legacy key underneath
      place(3, 0, 'com.elgato.philipshue.power', { id: 'l' }), // third-party
    ]);
    expect(plan.map((k) => k.route)).toEqual(['same', 'live', 'restart', 'restart']);
    expect(plan[1]).toMatchObject({ coord: 'a2', before: 'empty', after: 'x.dev' });
  });
});

describe('applyLayout', () => {
  it('says so and touches nothing when every key is already in place', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A') });
    const d = deps({ board: b });
    expect(await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'app', app: '/A.app' })], d)).toBe('unchanged');
    expect(d.writeInPlace).not.toHaveBeenCalled();
  });

  it('a move goes live destination-first, and the source is cleared only after it landed', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    const sent: string[] = [];
    const d = deps({ board: b, sendSlot: async (c) => (sent.push(String(c.coord)), 200) });
    const outcome = await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'empty' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'app', app: '/A.app' })],
      d,
    );
    expect(outcome).toBe('live');
    expect(sent).toEqual(['a2', 'a1']);
  });

  it('never clears a source when the destination failed live, and finishes through the restart write', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    const sent: string[] = [];
    const d = deps({ board: b, sendSlot: async (c) => (sent.push(String(c.coord)), c.coord === 'a2' ? 500 : 200) });
    const outcome = await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'empty' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'app', app: '/A.app' })],
      d,
    );
    // a1 (the source) was never cleared live; a2 is sent once more to restore it after its 500.
    expect(sent).toEqual(['a2', 'a2']);
    expect(outcome).toBe('restarted');
    expect(d.writeInPlace).toHaveBeenCalledTimes(1);
  });

  it('a swap that half-lands live is rolled back, so no key ends up on two coordinates', async () => {
    const A = { kind: 'app', app: '/A.app' };
    const B = { kind: 'app', app: '/B.app' };
    const b = board({ '0,0': slot(A, 'A'), '1,0': slot(B, 'B') });
    const sent: Array<[string, unknown]> = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async (c) => {
        sent.push([String(c.coord), c.app]);
        return c.coord === 'a2' && c.app === '/A.app' ? 500 : 200;
      },
    });
    const outcome = await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', B), place(1, 0, 'gg.pim.jetstream.slot', A)],
      d,
    );
    expect(outcome).toBe('declined');
    // a1 took B live, a2 failed, so a1 was put back to A.
    expect(sent).toContainEqual(['a1', '/B.app']);
    expect(sent).toContainEqual(['a1', '/A.app']);
    // a2's 500 can come after its settings were saved, so it is put back to B as well.
    expect(sent).toContainEqual(['a2', '/B.app']);
  });

  it('a key the plugin refused outright (404) is not "restored", so it is not reported as unrestored', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    const sent: string[] = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async (c) => (sent.push(String(c.coord)), c.coord === 'a2' ? 404 : 200),
    });
    await applyLayout([place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' })], d);
    expect(sent).toEqual(['a2']);
    expect(d.said.join('\n')).not.toContain('could not be put back');
  });

  it('applies nothing, live or by restart, when the deck switched page since the preview', async () => {
    const A = { kind: 'app', app: '/A.app' };
    const previewed = { ...board({ '0,0': slot(A, 'A') }), pageId: 'page-a' };
    const sent: string[] = [];
    const d = deps({
      board: previewed,
      boardOnScreen: () => ({ ...previewed, pageId: 'page-b' }),
      sendSlot: async (c) => (sent.push(String(c.coord)), 200),
    });
    const outcome = await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(5, 3, 'com.elgato.philipshue.power', {})],
      d,
    );
    expect(outcome).toBe('failed');
    expect(sent).toEqual([]);
    expect(d.writeInPlace).not.toHaveBeenCalled();
    expect(d.said.join('\n')).toContain('different page or profile');
  });

  it('applies when the deck still shows the previewed page', async () => {
    const previewed = { ...board({ '0,0': slot({ kind: 'empty' }, '·') }), pageId: 'page-a' };
    const d = deps({ board: previewed, boardOnScreen: () => ({ ...previewed }) });
    expect(await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'fleet' })], d)).toBe('live');
  });

  it('the in-place write targets the page the plan was made against', async () => {
    const b = { ...board({}), pageId: 'page-a' };
    const d = deps({ board: b });
    await applyLayout([place(5, 3, 'com.elgato.philipshue.power', {})], d);
    expect((d.writeInPlace as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe('page-a');
  });

  it('a third-party key is written in place after a confirm, with legacy keys folded into the same restart', async () => {
    const b = board({ '0,0': { uuid: 'gg.pim.jetstream.project', settings: { path: '/r', name: 'r' }, label: 'r' } });
    const d = deps({ board: b });
    const outcome = await applyLayout([place(5, 3, 'com.elgato.philipshue.power', { id: 'l' })], d);
    expect(outcome).toBe('restarted');
    const written = (d.writeInPlace as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Placement[];
    expect(written.map((p) => `${p.column},${p.row}:${p.uuid}`)).toEqual([
      '0,0:gg.pim.jetstream.slot', // the legacy project key, migrated
      '5,3:com.elgato.philipshue.power',
    ]);
  });

  it('a declined restart changes nothing', async () => {
    const d = deps({ board: board({}), confirm: async () => false });
    expect(await applyLayout([place(5, 3, 'com.elgato.philipshue.power', {})], d)).toBe('declined');
    expect(d.writeInPlace).not.toHaveBeenCalled();
  });

  it('without a board it falls back to an import file', async () => {
    const d = deps({ board: null });
    expect(await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'fleet' })], d)).toBe('imported');
    expect(d.importProfile).toHaveBeenCalledTimes(1);
  });
});
