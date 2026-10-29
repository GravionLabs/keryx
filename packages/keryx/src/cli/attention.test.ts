import { describe, expect, it, vi } from 'vitest';
import {
  runAttentionAck,
  runAttentionAnswer,
  runAttentionCreate,
  runAttentionList,
} from './attention.js';

function harness(reply: () => Response | Promise<Response>) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply());
  const deps = {
    fetch: fetchMock as unknown as typeof fetch,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    user: () => 'jerome',
  };
  const sent = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return {
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
  };
  return { out, err, deps, sent, fetchMock };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const down = () => {
  throw new TypeError('fetch failed');
};
const base = { url: 'http://127.0.0.1:1/' };

describe('runAttentionCreate', () => {
  it('posts the attention and prints its id', async () => {
    const h = harness(() => json(201, { id: 12 }));
    const code = await runAttentionCreate(
      {
        ...base,
        kind: 'BLOCKED',
        issue: '7',
        summary: 'blocked',
        option: ['retry', 'skip'],
        action: '{"type":"merge","pr":123}',
        repo: 'o/r',
        agentId: 'a',
      },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.out).toEqual(['12']);
    expect(h.sent()).toEqual({
      url: 'http://127.0.0.1:1/attention',
      method: 'POST',
      body: {
        kind: 'BLOCKED',
        issue: 7,
        summary: 'blocked',
        options: ['retry', 'skip'],
        action: { type: 'merge', pr: 123 },
        repo: 'o/r',
        agentId: 'a',
      },
    });
  });

  it('exits 0 with a notice and no id when the bus is not running', async () => {
    const h = harness(down);
    const code = await runAttentionCreate(
      { ...base, kind: 'QUESTION', issue: '1', summary: 's' },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err[0]).toMatch(/bus not running at http:\/\/127\.0\.0\.1:1.*not created/);
  });

  it('exits 1 with the bus message when the attention is rejected', async () => {
    const h = harness(() => json(400, { error: 'kind: Invalid option\u0007' }));
    const code = await runAttentionCreate(
      { ...base, kind: 'GATE', issue: '1', summary: 's' },
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.err).toEqual(['keryx: kind: Invalid option?']);
  });

  it.each([
    [{ issue: 'x' }, /--issue must be a positive integer/],
    [{ issue: '0' }, /--issue must be a positive integer/],
    [{ action: '{' }, /--action must be valid JSON/],
    [{ action: '[1]' }, /--action must be a JSON object/],
  ])('exits 2 for %j without calling the bus', async (over, message) => {
    const h = harness(() => json(201, { id: 1 }));
    const code = await runAttentionCreate(
      { ...base, kind: 'BLOCKED', issue: '1', summary: 's', ...over },
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.err[0]).toMatch(message);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('runAttentionList', () => {
  const record = {
    id: 3,
    state: 'answered',
    kind: 'BLOCKED',
    issue: 7,
    summary: 'blocked',
    answerText: 'retry',
  };

  it('passes the filters and prints one line per attention', async () => {
    const h = harness(() => json(200, { attention: [record] }));
    const code = await runAttentionList(
      {
        ...base,
        state: 'answered',
        kind: 'BLOCKED',
        issue: '7',
        since: '2026-01-01T00:00',
        limit: '5',
      },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.sent().url).toBe(
      'http://127.0.0.1:1/attention?state=answered&kind=BLOCKED&issue=7&since=2026-01-01T00%3A00&limit=5',
    );
    expect(h.out).toEqual(['3\tanswered\tBLOCKED\t#7\tblocked -> retry']);
  });

  it('prints the JSON array with --json', async () => {
    const h = harness(() => json(200, { attention: [record] }));
    await runAttentionList({ ...base, json: true }, h.deps);
    expect(h.sent().url).toBe('http://127.0.0.1:1/attention');
    expect(JSON.parse(h.out[0] ?? '')).toEqual([record]);
  });

  it('exits 1 when the bus is not running or rejects the query', async () => {
    const gone = harness(down);
    expect(await runAttentionList(base, gone.deps)).toBe(1);
    expect(gone.err[0]).toMatch(/bus not running/);
    const bad = harness(() => json(400, { error: 'state must be one of open, answered, acked' }));
    expect(await runAttentionList({ ...base, state: 'x' }, bad.deps)).toBe(1);
    expect(bad.err[0]).toMatch(/state must be one of/);
  });
});

describe('runAttentionAnswer and runAttentionAck', () => {
  it('answers with --by, else the login name', async () => {
    const a = harness(() => json(200, {}));
    expect(await runAttentionAnswer('4', 'retry', { ...base, by: 'me' }, a.deps)).toBe(0);
    expect(a.sent()).toEqual({
      url: 'http://127.0.0.1:1/attention/4/answer',
      method: 'POST',
      body: { text: 'retry', by: 'me' },
    });
    const b = harness(() => json(200, {}));
    await runAttentionAnswer('4', 'retry', base, b.deps);
    expect(b.sent().body).toEqual({ text: 'retry', by: 'jerome' });
  });

  it('acks', async () => {
    const h = harness(() => json(200, {}));
    expect(await runAttentionAck('4', base, h.deps)).toBe(0);
    expect(h.sent()).toEqual({
      url: 'http://127.0.0.1:1/attention/4/ack',
      method: 'POST',
      body: { by: 'jerome' },
    });
  });

  it('exits 1 on 404, 409, a refused answer and a missing bus; 2 for a bad id', async () => {
    const conflict = harness(() => json(409, { error: 'attention 4 is open; cannot ack' }));
    expect(await runAttentionAck('4', base, conflict.deps)).toBe(1);
    expect(conflict.err).toEqual(['keryx: attention 4 is open; cannot ack']);
    const refused = harness(() => json(400, { error: 'answer must be one of: retry, skip' }));
    expect(await runAttentionAnswer('4', 'abort', base, refused.deps)).toBe(1);
    const missing = harness(() => json(404, null));
    expect(await runAttentionAck('4', base, missing.deps)).toBe(1);
    expect(missing.err).toEqual(['keryx: HTTP 404']);
    const gone = harness(down);
    expect(await runAttentionAnswer('4', 'x', base, gone.deps)).toBe(1);
    expect(await runAttentionAck('4', base, gone.deps)).toBe(1);
    const bad = harness(() => json(200, {}));
    expect(await runAttentionAck('x', base, bad.deps)).toBe(2);
    expect(await runAttentionAnswer('0', 'x', base, bad.deps)).toBe(2);
    expect(bad.fetchMock).not.toHaveBeenCalled();
  });
});
