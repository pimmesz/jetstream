import { describe, it, expect, vi } from 'vitest';
import { applyLayout, changedSincePlan, planLayout, SLOT, type ApplyDeps, type PendingKey } from './chat-apply';
import { legacyMigrations, type BoardLayout, type BoardKey } from './board-layout';
import type { Placement } from './layout';
import { DECK_MODELS } from './profile';
import type { StoredAction } from './profile-store';
import { parseSlotCommand, sameSlot } from './slot-command';

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

  it('never skips a pending key as unchanged: Stream Deck may have lost it, so it goes live again', () => {
    const X = { kind: 'url', url: 'https://x.dev' };
    const pendingX: PendingKey = { ...slot(X, 'x.dev'), isPending: true };
    const plan = planLayout(board({ '0,0': pendingX }), [place(0, 0, SLOT, X)]);
    expect(plan.map((k) => k.route)).toEqual(['live']);
  });
});

describe('applyLayout', () => {
  it('says so and touches nothing when every key is already in place', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A') });
    const d = deps({ board: b });
    expect(await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'app', app: '/A.app' })], d)).toBe('unchanged');
    expect(d.writeInPlace).not.toHaveBeenCalled();
  });

  it('confirms an unchanged slot before replacing a key, so a move that overwrites its source cannot lose it', async () => {
    const X = { kind: 'url', url: 'https://x.dev' };
    const S = { kind: 'url', url: 'https://slack.dev' };
    // The plan sees X at a2 too, but the deck lost that copy: only a1 still holds X.
    const b = board({ '0,0': slot(X, 'x'), '1,0': slot(X, 'x') });
    const held = new Map<string, unknown>([
      ['a1', X],
      ['a2', { kind: 'empty' }],
    ]);
    const writes: string[] = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async ({ coord, expect: seen, deck: _deck, ...settings }) => {
        if (seen !== undefined && !sameSlot(held.get(String(coord)), seen)) return 409;
        writes.push(String(coord));
        held.set(String(coord), settings);
        return 200;
      },
    });
    await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', S), place(1, 0, 'gg.pim.jetstream.slot', X)], d);
    expect(held.get('a1')).toEqual(X);
    expect(writes).toEqual([]); // the confirm of a2 was refused before a1 was ever written
  });

  it('never undoes a confirm: it rewrote only what the key already held', async () => {
    const X = { kind: 'url', url: 'https://x.dev' };
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot(X, 'x') });
    const sent: string[] = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      // a2 is confirmed; the replace of a1 then fails with no answer, so a1 is rolled back.
      sendSlot: async (c) => (sent.push(String(c.coord)), c.coord === 'a1' ? -1 : 200),
    });
    await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://s.dev' }), place(1, 0, 'gg.pim.jetstream.slot', X)], d);
    expect(sent).toEqual(['a2', 'a1', 'a1']);
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

  describe('a move whose destination disk already shows, while the deck holds it empty (an unsaved edit)', () => {
    const Y = { kind: 'url', url: 'https://y.dev' };
    const pendingY: PendingKey = { ...slot(Y, 'y.dev'), isPending: true };
    const b = board({ '0,0': slot(Y, 'y.dev'), '1,0': pendingY });
    const moveBack = [place(0, 0, SLOT, Y), place(1, 0, SLOT, { kind: 'empty' })];

    it('goes live only after the plugin confirms the destination, so the source is never cleared', async () => {
      const held = new Map<string, unknown>([
        ['a1', { kind: 'empty' }],
        ['a2', Y],
      ]);
      const sent: Array<Record<string, unknown>> = [];
      const d = deps({
        board: b,
        confirm: async () => false,
        // Like the plugin: a write whose `expect` is not what the key holds is refused (409).
        sendSlot: async (body) => {
          sent.push(body);
          const { coord, expect: seen, ...settings } = body;
          if (!sameSlot(held.get(String(coord)), seen)) return 409;
          held.set(String(coord), settings);
          return 200;
        },
      });
      expect(await applyLayout(moveBack, d)).toBe('declined');
      expect(sent).toEqual([{ coord: 'a1', ...Y, expect: Y, deck: 'xl' }]);
      expect(held.get('a2')).toEqual(Y);
    });

    it('a restart write compares the destination after the quit, without writing it', async () => {
      const written: Placement[][] = [];
      const d = deps({
        board: b,
        pluginAlive: async () => false,
        writeInPlace: async (_dir, placements, _pageId, changedSincePlan) => {
          written.push(placements);
          // Stream Deck saved what it held on the way out: a1 empty, a2 holding Y.
          const changed = changedSincePlan({ '0,0': { UUID: SLOT, Settings: { kind: 'empty' } }, '1,0': { UUID: SLOT, Settings: Y } });
          if (changed.length === 0) return { ok: true, backup: '/bak', removed: [] };
          return { ok: false, reason: `these keys changed since the plan was made: ${changed.join(', ')}`, changed };
        },
      });
      expect(await applyLayout(moveBack, d)).toBe('reloaded');
      expect(written[0]?.map((p) => `${p.column},${p.row}`)).toEqual(['1,0']);
      expect(d.said.join('\n')).toContain('these keys changed since the plan was made: a1');
    });
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
    const bodies: Array<Record<string, unknown>> = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async (c) => {
        sent.push([String(c.coord), c.app]);
        bodies.push(c);
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
    // The rollback only applies while a1 still holds what chat wrote there.
    expect(bodies).toContainEqual({ coord: 'a1', ...A, expect: B, deck: 'xl' });
  });

  it('a rollback of a cleared key expects what the plugin stored there, not the colour chat sent', async () => {
    const A = { kind: 'app', app: '/A.app' };
    const B = { kind: 'app', app: '/B.app' };
    const b = board({ '0,0': slot(A, 'A'), '1,0': slot(B, 'B') });
    const bodies: Array<Record<string, unknown>> = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async (c) => (bodies.push(c), c.coord === 'a2' && sameSlot(c.expect, B) ? 404 : 200),
    });
    await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'empty', color: '#e5484d' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'empty' })],
      d,
    );
    // A cleared key keeps no colour, so `expect` must be the bare empty slot or the plugin refuses the rollback.
    expect(bodies).toContainEqual({ coord: 'a1', ...A, expect: { kind: 'empty' }, deck: 'xl' });
  });

  it('rolls a never-configured slot ({}) back as an empty slot the plugin can parse', async () => {
    const b = board({ '0,0': slot({}, '·'), '1,0': slot({ kind: 'empty' }, '·') });
    const bodies: Array<Record<string, unknown>> = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      // Like the plugin: a body without a parseable kind is refused with 400.
      sendSlot: async (c) => (bodies.push(c), parseSlotCommand(c) === null ? 400 : c.coord === 'a2' ? 409 : 200),
    });
    await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://y.dev' })],
      d,
    );
    expect(bodies).toContainEqual({ coord: 'a1', kind: 'empty', expect: { kind: 'url', url: 'https://x.dev' }, deck: 'xl' });
    expect(d.said.join('\n')).not.toContain('may still hold the new settings');
    expect(d.said).toContain('Nothing changed.');
  });

  it('never clears a configured key the plugin cannot parse: its rollback is refused and reported', async () => {
    // A native Website key migrated with a URL /slot does not accept.
    const original = { kind: 'url', url: 'intranet.local/wiki' };
    const b = board({ '0,0': slot(original, 'wiki'), '1,0': slot({ kind: 'empty' }, '·') });
    const bodies: Array<Record<string, unknown>> = [];
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async (c) => (bodies.push(c), parseSlotCommand(c) === null ? 400 : c.coord === 'a2' ? 409 : 200),
    });
    await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://y.dev' })],
      d,
    );
    expect(bodies).toContainEqual({ coord: 'a1', ...original, expect: { kind: 'url', url: 'https://x.dev' }, deck: 'xl' });
    expect(bodies).not.toContainEqual(expect.objectContaining({ coord: 'a1', kind: 'empty' }));
    expect(d.said).toContain('Not restarted, so these keys may still hold the new settings: a1.');
  });

  it('a failed restart write names the keys whose undo was not confirmed instead of saying nothing changed', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    const d = deps({
      board: b,
      sendSlot: async (c) => (c.coord === 'a2' ? 404 : c.expect !== undefined && c.kind === 'app' ? -1 : 200),
      writeInPlace: vi.fn(async () => ({ ok: false as const, reason: 'another chat holds the profile lock' })),
    });
    const outcome = await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://y.dev' })],
      d,
    );
    expect(outcome).toBe('failed');
    expect(d.said.join('\n')).not.toContain('Your board was not changed.');
    expect(d.said.join('\n')).toContain('Apart from that nothing changed, but these keys may still hold the new settings: a1.');
    // Only the compare's call-off happens after a restart; a busy lock never quit Stream Deck.
    expect(d.said.join('\n')).not.toContain('nothing was written');
  });

  it('a styled spacer is put back as a plain empty key, and chat says what it lost', async () => {
    const spacer = { kind: 'empty', color: '#e5484d' };
    const b = board({ '0,0': slot(spacer, '·'), '1,0': slot({ kind: 'empty' }, '·') });
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async (c) => (parseSlotCommand(c) === null ? 400 : c.coord === 'a2' ? 409 : 200),
    });
    await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://y.dev' })],
      d,
    );
    expect(d.said).toContain('Put back as plain empty keys, without their colour, label or icon: a1.');
    expect(d.said).toContain('Not restarted, so these keys lost their colour, label or icon: a1.');
    expect(d.said).not.toContain('Nothing changed.');
  });

  it('a declined restart names the keys that kept the new settings instead of saying nothing changed', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    const d = deps({
      board: b,
      confirm: async () => false,
      // a1 lands, a2 is refused, and a1's rollback gets no answer: a1 keeps chat's edit.
      sendSlot: async (c) => (c.coord === 'a2' ? 404 : c.expect !== undefined && c.kind === 'app' ? -1 : 200),
    });
    await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(1, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://y.dev' })],
      d,
    );
    expect(d.said).not.toContain('Nothing changed.');
    expect(d.said).toContain('Not restarted, so these keys may still hold the new settings: a1.');
  });

  it('a rollback the plugin refuses (409) leaves the key alone and is not reported as unrestored', async () => {
    const A = { kind: 'app', app: '/A.app' };
    const C = { kind: 'url', url: 'https://c.dev' };
    const b = board({ '0,0': slot(A, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    // A plugin that, like the real one, refuses a write whose `expect` does not match the key.
    const held = new Map<string, unknown>([['a1', A]]);
    const d = deps({
      board: b,
      confirm: async () => false,
      sendSlot: async ({ coord, expect: seen, ...settings }) => {
        if (coord === 'a2') {
          held.set('a1', C); // the user flipped page before a2 landed: a1 now shows another key
          return 404;
        }
        if (seen !== undefined && !sameSlot(held.get(String(coord)), seen)) return 409;
        held.set(String(coord), settings);
        return 200;
      },
    });
    const outcome = await applyLayout(
      [place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' }), place(1, 0, 'gg.pim.jetstream.slot', A)],
      d,
    );
    expect(outcome).toBe('declined');
    expect(held.get('a1')).toEqual(C); // the other page's key was not overwritten
    expect(d.said.join('\n')).not.toContain('may still hold the new settings');
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
    expect(d.said.join('\n')).not.toContain('may still hold the new settings');
    // Only a 409 means an unsaved edit may be in the way; after a 404 the restart write is the remedy.
    expect(d.said.join('\n')).not.toContain('may not have saved a recent edit yet');
  });

  it('a 401 also points at updating the plugin, since a plugin older than signing refuses every signed edit', async () => {
    const b = board({ '0,0': slot({ kind: 'empty' }, '·') });
    const d = deps({ board: b, confirm: async () => false, sendSlot: async () => 401 });
    await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'fleet' })], d);
    expect(d.said.join('\n')).toContain('a plugin older than this CLI');
    expect(d.said.join('\n')).toContain('update the plugin');
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

  it('every live write tells the plugin what the plan saw there, so a switched page is refused', async () => {
    const A = { kind: 'app', app: '/A.app' };
    const b = board({ '0,0': slot(A, 'A') });
    const bodies: Array<Record<string, unknown>> = [];
    const d = deps({ board: b, confirm: async () => false, sendSlot: async (c) => (bodies.push(c), 409) });
    const outcome = await applyLayout([place(0, 0, 'gg.pim.jetstream.slot', { kind: 'url', url: 'https://x.dev' })], d);
    expect(bodies[0]).toMatchObject({ coord: 'a1', kind: 'url', expect: A });
    expect(bodies).toHaveLength(1); // a 409 changed nothing, so there is nothing to roll back
    expect(d.said.join('\n')).toContain('changed since the plan');
    expect(d.said.join('\n')).toContain('may not have saved a recent edit yet (from another chat or on the deck itself)');
    expect(d.said.join('\n')).toContain('wait a few seconds, decline the restart, then send the request again');
    expect(d.said.join('\n')).not.toContain('may still hold the new settings');
    expect(outcome).toBe('declined'); // fell through to the restart write, which the user declined
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

  it('a restart write that finds a planned key changed after the quit writes nothing and asks to send again', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A') });
    const d = deps({
      board: b,
      // Like the real writer: ask the compare about the page Stream Deck saved on the way out.
      writeInPlace: async (_dir, _placements, _pageId, changedSincePlan) => {
        const changed = changedSincePlan({ '0,0': { UUID: SLOT, Settings: { kind: 'app', app: '/B.app' } } });
        if (changed.length === 0) return { ok: true, backup: '/bak', removed: [] };
        return { ok: false, reason: `these keys changed since the plan was made: ${changed.join(', ')}`, changed };
      },
    });
    const outcome = await applyLayout([place(0, 0, 'com.elgato.philipshue.power', { id: 'l' })], d);
    expect(outcome).toBe('reloaded');
    const said = d.said.join('\n');
    expect(said).toContain('these keys changed since the plan was made: a1');
    expect(said).toContain('Send the request again to plan it against the board as it is now.');
    expect(said).not.toContain('Updated');
  });

  it('a restart write also stops when a folded legacy key changed after the plan', async () => {
    // The user edits only f4, but the restart also rewrites the legacy key at a1, so a1 is compared too.
    const b = board({ '0,0': { uuid: 'gg.pim.jetstream.project', settings: { path: '/r', name: 'r' }, label: 'r' } });
    const d = deps({
      board: b,
      writeInPlace: async (_dir, _placements, _pageId, changedSincePlan) => {
        const changed = changedSincePlan({
          '0,0': { UUID: 'gg.pim.jetstream.project', Settings: { path: '/other', name: 'other' } },
        });
        if (changed.length === 0) return { ok: true, backup: '/bak', removed: [] };
        return { ok: false, reason: `these keys changed since the plan was made: ${changed.join(', ')}`, changed };
      },
    });
    expect(await applyLayout([place(5, 3, 'com.elgato.philipshue.power', { id: 'l' })], d)).toBe('reloaded');
    expect(d.said.join('\n')).toContain('these keys changed since the plan was made: a1');
  });

  it('a restart write that replaces a key also stops when an unchanged third-party key it keeps changed', async () => {
    // The plan keeps the Hue key at a1 and replaces the slot at a2; the restart never rewrites a1 itself.
    const hue = { uuid: 'com.elgato.philipshue.power', settings: { id: 'l' }, label: 'hue' };
    const b = board({ '0,0': hue, '1,0': slot({ kind: 'url', url: 'https://x.dev' }, 'x') });
    const d = deps({
      board: b,
      writeInPlace: async (_dir, _placements, _pageId, changedSincePlan) => {
        const changed = changedSincePlan({
          '0,0': { UUID: hue.uuid, Settings: { id: 'other' } },
          '1,0': { UUID: SLOT, Settings: { kind: 'url', url: 'https://x.dev' } },
        });
        if (changed.length === 0) return { ok: true, backup: '/bak', removed: [] };
        return { ok: false, reason: `these keys changed since the plan was made: ${changed.join(', ')}`, changed };
      },
    });
    const outcome = await applyLayout([place(0, 0, hue.uuid, hue.settings), place(1, 0, 'com.example.thing', {})], d);
    expect(outcome).toBe('reloaded');
    expect(d.said.join('\n')).toContain('these keys changed since the plan was made: a1');
  });

  it('live edits and their rollback name the deck the plan is for, which no settings field can override', async () => {
    const b = board({ '0,0': slot({ kind: 'app', app: '/A.app' }, 'A'), '1,0': slot({ kind: 'empty' }, '·') });
    const bodies: Array<Record<string, unknown>> = [];
    const d = deps({ board: b, confirm: async () => false, sendSlot: async (c) => (bodies.push(c), c.coord === 'a2' ? 409 : 200) });
    await applyLayout(
      [place(0, 0, SLOT, { kind: 'url', url: 'https://x.dev', deck: 'mini' }), place(1, 0, SLOT, { kind: 'url', url: 'https://y.dev' })],
      d,
    );
    expect(bodies.map((c) => c.coord)).toEqual(['a1', 'a2', 'a1']); // a1's edit, a2's 409, a1's rollback
    expect(bodies.map((c) => c.deck)).toEqual(['xl', 'xl', 'xl']);
  });

  it('a 404 says the key may sit on two Stream Decks of the same model', async () => {
    const b = board({ '0,0': slot({ kind: 'empty' }, '·') });
    const d = deps({ board: b, confirm: async () => false, sendSlot: async () => 404 });
    await applyLayout([place(0, 0, SLOT, { kind: 'fleet' })], d);
    expect(d.said.join('\n')).toContain('a1: that key is not on the Stream Deck page on screen, or is on two Stream Decks of the same model');
  });

  it('tells onConflict the keys the plugin refused with a 409, and only those', async () => {
    const b = board({ '0,0': slot({ kind: 'empty' }, '·'), '1,0': slot({ kind: 'empty' }, '·') });
    const onConflict = vi.fn();
    const d = deps({ board: b, confirm: async () => false, onConflict, sendSlot: async (c) => (c.coord === 'a2' ? 409 : 200) });
    await applyLayout([place(0, 0, SLOT, { kind: 'fleet' }), place(1, 0, SLOT, { kind: 'fleet' })], d);
    expect(onConflict).toHaveBeenCalledExactlyOnceWith(['1,0']);
    await applyLayout([place(0, 0, SLOT, { kind: 'fleet' })], d);
    expect(onConflict).toHaveBeenCalledTimes(1); // a write that landed is no conflict
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

describe('changedSincePlan', () => {
  const A = { kind: 'app', app: '/A.app' };
  const RED = '#e5484d';
  const PROJECT = 'gg.pim.jetstream.project';
  /** A key as Stream Deck stores it on disk, with the fields the compare must look past. */
  const stored = (UUID: string, Settings: unknown): StoredAction => ({ ActionID: 'id', Name: 'x', Settings, State: 0, States: [{}], UUID });
  const hue = place(0, 0, 'com.elgato.philipshue.power', { id: 'l' });
  const legacy = board({ '0,0': { uuid: PROJECT, settings: { path: '/r', name: 'r' }, label: 'r' } });
  const website = board({ '0,0': { uuid: 'com.elgato.streamdeck.system.website', settings: { path: 'google.com' }, label: 'google.com' } });

  interface Case {
    name: string;
    board: BoardLayout;
    written: Placement[];
    disk: Record<string, StoredAction>;
  }

  it.each<Case>([
    {
      name: 'disk holds a different app',
      board: board({ '0,0': slot(A, 'A') }),
      written: [hue],
      disk: { '0,0': stored(SLOT, { kind: 'app', app: '/B.app' }) },
    },
    { name: 'a key the plan saw is gone', board: board({ '0,0': slot(A, 'A') }), written: [hue], disk: {} },
    { name: 'a key appeared where the plan saw none', board: board({}), written: [hue], disk: { '0,0': stored(SLOT, A) } },
    {
      name: 'a folded legacy key changed, though the user edited another key',
      board: legacy,
      written: [...legacyMigrations(legacy), place(5, 3, 'com.elgato.philipshue.power', { id: 'l' })],
      disk: { '0,0': stored(PROJECT, { path: '/other', name: 'other' }) },
    },
    {
      // The folded url has no scheme, so /slot refuses it and never stores it as an empty key.
      name: 'an empty slot replaced a legacy Website key whose url the plugin refuses',
      board: website,
      written: [...legacyMigrations(website), place(5, 3, 'com.elgato.philipshue.power', { id: 'l' })],
      disk: { '0,0': stored(SLOT, {}) },
    },
  ])('names a1 when $name', ({ board: b, written, disk }) => {
    expect(changedSincePlan(b, written, disk)).toEqual(['a1']);
  });

  it.each<Case>([
    { name: 'the key is unchanged', board: board({ '0,0': slot(A, 'A') }), written: [hue], disk: { '0,0': stored(SLOT, A) } },
    {
      name: 'a never-configured slot ({}) is now stored as empty',
      board: board({ '0,0': slot({}, '·') }),
      written: [hue],
      disk: { '0,0': stored(SLOT, { kind: 'empty' }) },
    },
    {
      name: 'a styled spacer came back from a rollback as plain empty',
      board: board({ '0,0': slot({ kind: 'empty', color: RED }, '·') }),
      written: [hue],
      disk: { '0,0': stored(SLOT, { kind: 'empty' }) },
    },
    {
      // Disk keeps the colour that the stored form drops, so only the raw compare matches it.
      name: 'an unchanged styled spacer sits under the new key',
      board: board({ '0,0': slot({ kind: 'empty', color: RED }, '·') }),
      written: [hue],
      disk: { '0,0': stored(SLOT, { kind: 'empty', color: RED }) },
    },
    {
      name: 'the key already holds the placement as the plugin stores it',
      board: board({ '0,0': slot(A, 'A') }),
      written: [place(0, 0, SLOT, { kind: 'url', url: 'https://x.dev', color: 'red' })],
      disk: { '0,0': stored(SLOT, { kind: 'url', url: 'https://x.dev', color: RED }) },
    },
    {
      name: 'Stream Deck saved a pending live edit the plan had laid over disk',
      board: board({ '0,0': slot({ kind: 'url', url: 'https://p.dev' }, 'p.dev') }),
      written: [hue],
      disk: { '0,0': stored(SLOT, { kind: 'url', url: 'https://p.dev' }) },
    },
    { name: 'the coordinate holds no key before and after', board: board({}), written: [hue], disk: {} },
    {
      name: 'a folded legacy key is unchanged',
      board: legacy,
      written: [...legacyMigrations(legacy), place(5, 3, 'com.elgato.philipshue.power', { id: 'l' })],
      disk: { '0,0': stored(PROJECT, { path: '/r', name: 'r' }) },
    },
  ])('passes when $name', ({ board: b, written, disk }) => {
    expect(changedSincePlan(b, written, disk)).toEqual([]);
  });
});
