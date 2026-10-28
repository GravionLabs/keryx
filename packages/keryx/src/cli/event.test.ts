import { describe, expect, it, vi } from 'vitest';
import { runEventCommand } from './event.js';

function run(args: Parameters<typeof runEventCommand>[1], fetchImpl?: typeof fetch) {
  const stderr: string[] = [];
  return runEventCommand('session.idle', args, {
    fetch: fetchImpl,
    stderr: (t) => stderr.push(t),
  }).then((code) => ({ code, stderr }));
}

describe('runEventCommand', () => {
  it('posts the event to /ingest', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ids":[1]}', { status: 202 }));
    const { code } = await run(
      { url: 'http://127.0.0.1:1/', issue: '4', data: '{"a":1}', repo: 'o/r', agentId: 'x' },
      fetchMock as unknown as typeof fetch,
    );
    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:1/ingest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      source: 'keryx-cli',
      type: 'session.idle',
      data: { a: 1 },
      issue: 4,
      repo: 'o/r',
      agentId: 'x',
    });
  });

  it('exits 0 with a notice on stderr when the bus is not running', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { code, stderr } = await run(
      { url: 'http://127.0.0.1:1' },
      down as unknown as typeof fetch,
    );
    expect(code).toBe(0);
    expect(stderr[0]).toMatch(/bus not running at http:\/\/127\.0\.0\.1:1/);
  });

  it('exits 1 when the bus rejects the event', async () => {
    const reject = vi.fn(
      async () => new Response('{"error":"item 0: type: bad"}', { status: 400 }),
    );
    const { code, stderr } = await run({ url: 'http://x' }, reject as unknown as typeof fetch);
    expect(code).toBe(1);
    expect(stderr[0]).toContain('item 0: type: bad');
  });

  it.each([
    [{ data: '{' }, /valid JSON/],
    [{ data: '[1]' }, /JSON object/],
    [{ issue: '0' }, /--issue/],
    [{ issue: 'x' }, /--issue/],
  ])('exits 2 for bad arguments %j without calling the bus', async (args, message) => {
    const fetchMock = vi.fn();
    const { code, stderr } = await run(
      { url: 'http://x', ...args },
      fetchMock as unknown as typeof fetch,
    );
    expect(code).toBe(2);
    expect(stderr[0]).toMatch(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
