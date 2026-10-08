import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHookPayload } from './index';
import { appendSpool, spoolProjection, takeSpool } from './spool';

describe('hook spool', () => {
  it('replays undelivered events oldest first and empties the spool', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    const now = 10_000_000;
    appendSpool(JSON.stringify({ hook_event_name: 'Stop', session_id: 'a', _at: now - 2_000 }), path);
    appendSpool(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'b', _at: now - 1_000 }), path);
    expect(takeSpool(path, now)).toEqual([
      { hook_event_name: 'Stop', session_id: 'a', _at: now - 2_000 },
      { hook_event_name: 'SessionEnd', session_id: 'b', _at: now - 1_000 },
    ]);
    expect(existsSync(path)).toBe(false);
    expect(takeSpool(path, now)).toEqual([]);
  });

  it('drops events older than an hour and lines that are not JSON', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    const now = 10_000_000;
    writeFileSync(path, `${JSON.stringify({ _at: now - 2 * 3600_000 })}\n{torn\n${JSON.stringify({ _at: now })}\n`);
    expect(takeSpool(path, now)).toEqual([{ _at: now }]);
  });

  it('replays in fire order even when the hooks appended out of order', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    const now = 10_000_000;
    appendSpool(JSON.stringify({ hook_event_name: 'Stop', _at: now - 1_000 }), path);
    appendSpool(JSON.stringify({ hook_event_name: 'Notification', _at: now - 2_000 }), path); // fired first
    expect(takeSpool(path, now).map((p) => (p as { hook_event_name: string }).hook_event_name)).toEqual(['Notification', 'Stop']);
  });

  it('refuses one payload that alone would overflow the cap', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    appendSpool(JSON.stringify({ big: 'x'.repeat(300 * 1024) }), path);
    expect(existsSync(path)).toBe(false);
    appendSpool(JSON.stringify({ hook_event_name: 'Stop', _at: Date.now() }), path);
    expect(takeSpool(path)).toEqual([expect.objectContaining({ hook_event_name: 'Stop' })]);
  });

  it('starts over instead of refusing the newest event once the cap would be passed', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    const now = Date.now();
    // Filler lines as long as the new one, so whatever room is left is too small for it.
    const filler = `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'b', _at: now - 5_000 })}\n`;
    writeFileSync(path, filler.repeat(Math.floor((256 * 1024) / filler.length)));
    appendSpool(JSON.stringify({ hook_event_name: 'Stop', session_id: 'a', _at: now - 1_000 }), path, now);
    expect(takeSpool(path, now)).toEqual([{ hook_event_name: 'Stop', session_id: 'a', _at: now - 1_000 }]);
  });

  it('starts over when its last append is older than any event a replay keeps', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    writeFileSync(path, '{"hook_event_name":"Stop","session_id":"old"}\n');
    const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(path, twoHoursAgo, twoHoursAgo);
    appendSpool('{"late":true}', path);
    expect(readFileSync(path, 'utf8')).toBe('{"late":true}\n');
  });

  it('never throws when the spool cannot be claimed or cleaned up', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'js-spool-')), 'spool.jsonl');
    mkdirSync(path); // a directory where the spool file should be
    expect(takeSpool(path)).toEqual([]);
  });

  it('spools only the fields the plugin reads back, and they parse to the same event', () => {
    const full = {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: '/r',
      notification_type: 'idle_prompt',
      source: 'resume',
      tool_name: 'Bash',
      agent_id: 'ag',
      background_tasks: [{ description: 'private task text' }],
      prompt: 'private prompt text',
      tool_input: { command: 'cat secrets' },
      _pid: 42,
      _at: 1_000,
    };
    const spooled = JSON.parse(JSON.stringify(spoolProjection(full))) as Record<string, unknown>;
    expect(JSON.stringify(spooled)).not.toContain('private');
    expect(spooled).not.toHaveProperty('tool_input');
    expect(spooled._pid).toBe(42);
    expect(parseHookPayload(spooled, 1_000)).toEqual(parseHookPayload(full, 1_000));
  });
});
