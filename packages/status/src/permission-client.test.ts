import { describe, it, expect } from 'vitest';
import { MAC_HEADER, NONCE_HEADER, permissionMac, runPermissionHook, type PermissionHookDeps } from './permission-client';
import { permissionDecisionJson } from './permission';

const REQUEST = '{"session_id":"s","tool_name":"Bash"}';

/** A hook run against a fake plugin: `answer` decides what comes back for the request it received. */
async function run(
  answer: (headers: Record<string, string>) => { body: string; mac: unknown },
  over: Partial<PermissionHookDeps> = {},
): Promise<{ out: string[]; sent: Array<Record<string, string>> }> {
  const out: string[] = [];
  const sent: Array<Record<string, string>> = [];
  await runPermissionHook({
    env: {},
    readStdin: async () => REQUEST,
    readToken: () => 'secret',
    nonce: () => 'n1',
    post: async (_body, headers) => {
      sent.push(headers);
      return answer(headers);
    },
    write: (s) => out.push(s),
    ...over,
  });
  return { out, sent };
}

describe('runPermissionHook', () => {
  it('re-emits a correctly signed decision from the canonical writer, and never sends the token', async () => {
    const decision = permissionDecisionJson('allow');
    const { out, sent } = await run(() => ({ body: decision, mac: permissionMac('secret', 'res', 'n1', decision) }));
    expect(out).toEqual([permissionDecisionJson('allow')]);
    expect(sent[0]).toEqual({ [NONCE_HEADER]: 'n1', [MAC_HEADER]: permissionMac('secret', 'req', 'n1', REQUEST) });
    expect(JSON.stringify(sent)).not.toContain('secret');
  });

  it('prints nothing for an unsigned or wrongly signed answer (a port squatter)', async () => {
    const decision = permissionDecisionJson('allow');
    expect((await run(() => ({ body: decision, mac: undefined }))).out).toEqual([]);
    expect((await run(() => ({ body: decision, mac: permissionMac('guess', 'res', 'n1', decision) }))).out).toEqual([]);
    // A request MAC replayed as the response MAC is refused too.
    expect((await run((h) => ({ body: decision, mac: h[MAC_HEADER] }))).out).toEqual([]);
  });

  it('prints nothing for a signed answer that is not a recognised decision', async () => {
    const hostile = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}},"extra":"x"}';
    const junk = 'not json';
    const signed = (body: string) => () => ({ body, mac: permissionMac('secret', 'res', 'n1', body) });
    expect((await run(signed(junk))).out).toEqual([]);
    // A valid shape is re-built, so extra fields from the socket never reach Claude.
    expect((await run(signed(hostile))).out).toEqual([permissionDecisionJson('allow')]);
  });

  it('signs a nonce that carries its send time, so the plugin can refuse a replayed request', async () => {
    const before = Date.now();
    const { sent } = await run(() => ({ body: '', mac: undefined }), { nonce: undefined });
    const nonce = sent[0]?.[NONCE_HEADER] ?? '';
    expect(nonce).toMatch(/^\d+\.[0-9a-f]{32}$/);
    expect(Number(nonce.split('.')[0])).toBeGreaterThanOrEqual(before);
    expect(Number(nonce.split('.')[0])).toBeLessThanOrEqual(Date.now());
    expect(sent[0]?.[MAC_HEADER]).toBe(permissionMac('secret', 'req', nonce, REQUEST));
  });

  it('does not ask at all without a token, or for a jetstream chat run', async () => {
    const never = (): never => {
      throw new Error('must not post');
    };
    expect((await run(never, { readToken: () => undefined })).sent).toEqual([]);
    expect((await run(never, { env: { JETSTREAM_SKIP_DECK: '1' } })).sent).toEqual([]);
  });
});
