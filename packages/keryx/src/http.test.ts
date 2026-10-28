import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from './db.js';
import { MAX_INGEST_BATCH, MAX_INGEST_BODY_BYTES, type RunningHttp, startHttp } from './http.js';

let db: Db;
let http: RunningHttp;

beforeEach(async () => {
  db = openDb(':memory:');
  http = await startHttp({
    config: { host: '127.0.0.1', port: 0 },
    db,
    stateDir: mkdtempSync(join(tmpdir(), 'keryx-http-')),
    heartbeatMs: 50,
  });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const post = (body: unknown, init: RequestInit = {}) =>
  fetch(`${http.url}/ingest`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });

const event = (over: Record<string, unknown> = {}) => ({
  source: 'claude-code',
  type: 'session.idle',
  ...over,
});

/** Raw request, so the Host header can be forged (fetch forbids it). */
function raw(path: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(http.url);
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /health', () => {
  it('answers ok', async () => {
    const res = await fetch(`${http.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('unknown route', () => {
  it('answers 404', async () => {
    expect((await fetch(`${http.url}/nope`)).status).toBe(404);
  });
});

describe('POST /ingest', () => {
  it('stores one event and answers 202 with its id', async () => {
    const res = await post(event({ issue: 4, data: { a: 1 } }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ids: [1] });
    expect(db.listEventsSince(0)[0]).toMatchObject({
      source: 'claude-code',
      type: 'session.idle',
      issue: 4,
      agentId: null,
      data: { a: 1 },
    });
  });

  it('stores a batch in order', async () => {
    const res = await post([event({ type: 'a.one' }), event({ type: 'a.two' })]);
    expect(await res.json()).toEqual({ ids: [1, 2] });
    expect(db.listEventsSince(0).map((e) => e.type)).toEqual(['a.one', 'a.two']);
  });

  it('is all-or-nothing: one invalid item stores none', async () => {
    const res = await post([event(), event({ type: 'Bad Type' })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^item 1: type:/);
    expect(db.newestEventId()).toBe(0);
  });

  it.each([
    ['client id', { id: 5 }],
    ['client at', { at: '2026-01-01T00:00:00Z' }],
  ])('rejects the server-owned %s', async (_, extra) => {
    expect((await post(event(extra))).status).toBe(400);
  });

  it('rejects invalid JSON, an empty batch and a non-object item', async () => {
    expect((await post('{')).status).toBe(400);
    expect((await post([])).status).toBe(400);
    const res = await post([1]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^item 0:/);
  });

  it('answers 413 for a batch over the limit', async () => {
    const res = await post(Array.from({ length: MAX_INGEST_BATCH + 1 }, () => event()));
    expect(res.status).toBe(413);
    expect(db.newestEventId()).toBe(0);
  });

  it('answers 413 for a body over the limit', async () => {
    const res = await post(event({ data: { blob: 'x'.repeat(MAX_INGEST_BODY_BYTES) } }));
    expect(res.status).toBe(413);
    expect(db.newestEventId()).toBe(0);
  });

  it('answers 405 for GET', async () => {
    expect((await fetch(`${http.url}/ingest`)).status).toBe(405);
  });

  it('requires application/json from a browser (Origin) but not from curl', async () => {
    const origin = { origin: http.url };
    const wrong = await post(event(), { headers: { ...origin, 'content-type': 'text/plain' } });
    expect(wrong.status).toBe(415);
    const ok = await post(event(), { headers: { ...origin, 'content-type': 'application/json' } });
    expect(ok.status).toBe(202);
    const noType = await post(event(), { headers: { 'content-type': 'text/plain' } });
    expect(noType.status).toBe(202);
  });
});

describe('Host/Origin guard', () => {
  it('rejects a foreign Host (DNS rebinding) on every route', async () => {
    for (const [path, method] of [
      ['/ingest', 'POST'],
      ['/events', 'GET'],
      ['/events/stream', 'GET'],
    ] as const) {
      expect(await raw(path, { host: 'evil.example' }, method)).toBe(403);
    }
  });

  it('rejects a foreign Origin', async () => {
    const res = await post(event(), { headers: { origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    expect(
      (await fetch(`${http.url}/events`, { headers: { origin: 'http://evil.example' } })).status,
    ).toBe(403);
    expect(db.newestEventId()).toBe(0);
  });

  it('accepts localhost as Host', async () => {
    const port = new URL(http.url).port;
    expect(await raw('/events', { host: `localhost:${port}` })).toBe(200);
  });
});

describe('GET /events', () => {
  it('queries with filters and pages', async () => {
    await post([event({ issue: 1 }), event({ issue: 2 }), event({ issue: 2 })]);
    const res = await fetch(`${http.url}/events?issue=2&limit=1`);
    const body = (await res.json()) as { events: { id: number }[]; next: number | null };
    expect(body.events.map((e) => e.id)).toEqual([2]);
    expect(body.next).toBe(2);
    const rest = (await (await fetch(`${http.url}/events?issue=2&after=2`)).json()) as {
      events: { id: number }[];
      next: number | null;
    };
    expect(rest.events.map((e) => e.id)).toEqual([3]);
    expect(rest.next).toBeNull();
  });

  it('answers 400 naming the bad parameter', async () => {
    const res = await fetch(`${http.url}/events?limit=0`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^limit/);
  });

  it('answers 405 for POST', async () => {
    expect((await fetch(`${http.url}/events`, { method: 'POST' })).status).toBe(405);
  });
});

interface Frame {
  id: string;
  data: { type: string };
}

/** Reads SSE frames from a stream until `count` data frames arrived. */
async function readFrames(res: Response, count: number): Promise<Frame[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Frame[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id !== undefined && data !== undefined)
        frames.push({ id, data: JSON.parse(data) as Frame['data'] });
    }
  }
  await reader.cancel();
  return frames;
}

describe('GET /events/stream', () => {
  it('replays events after Last-Event-ID, then streams live ones', async () => {
    await post([event({ type: 'a.one' }), event({ type: 'a.two' }), event({ type: 'a.three' })]);
    const res = await fetch(`${http.url}/events/stream`, { headers: { 'last-event-id': '1' } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = readFrames(res, 3);
    await post(event({ type: 'a.four' }));
    const got = await frames;
    expect(got.map((f) => f.id)).toEqual(['2', '3', '4']);
    expect(got.map((f) => f.data.type)).toEqual(['a.two', 'a.three', 'a.four']);
  });

  it('accepts ?since= as the resume point', async () => {
    await post([event(), event()]);
    const res = await fetch(`${http.url}/events/stream?since=1`);
    expect((await readFrames(res, 1)).map((f) => f.id)).toEqual(['2']);
  });

  it('sends only live events without a resume point', async () => {
    await post(event({ type: 'a.old' }));
    const res = await fetch(`${http.url}/events/stream`);
    const frames = readFrames(res, 1);
    await post(event({ type: 'a.new' }));
    expect((await frames).map((f) => f.data.type)).toEqual(['a.new']);
  });

  it('clamps a resume id beyond the newest event so later events are still delivered', async () => {
    await post(event());
    const res = await fetch(`${http.url}/events/stream`, { headers: { 'last-event-id': '999' } });
    const frames = readFrames(res, 1);
    await post(event({ type: 'a.next' }));
    expect((await frames).map((f) => f.id)).toEqual(['2']);
  });

  it('answers 400 for a malformed resume id', async () => {
    const bad = await fetch(`${http.url}/events/stream`, { headers: { 'last-event-id': 'x' } });
    expect(bad.status).toBe(400);
    expect((await fetch(`${http.url}/events/stream?since=-1`)).status).toBe(400);
  });

  it('sends heartbeats', async () => {
    const res = await fetch(`${http.url}/events/stream`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(': heartbeat\n\n');
    await reader.cancel();
  });
});

describe('maxEventStreams', () => {
  it('answers 503 beyond the limit', async () => {
    await http.close();
    http = await startHttp({
      config: { host: '127.0.0.1', port: 0 },
      db,
      stateDir: mkdtempSync(join(tmpdir(), 'keryx-http-')),
      maxEventStreams: 1,
    });
    const first = await fetch(`${http.url}/events/stream`);
    expect((await fetch(`${http.url}/events/stream`)).status).toBe(503);
    await first.body?.cancel();
  });
});
