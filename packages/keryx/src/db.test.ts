import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, MIGRATIONS, openDb } from './db.js';
import type { IngestEvent } from './events/schema.js';

const event = (over: Partial<IngestEvent> = {}): IngestEvent => ({
  source: 'claude-code',
  type: 'session.idle',
  agentId: null,
  issue: null,
  repo: null,
  data: {},
  ...over,
});

let db: Db;
afterEach(() => db.close());

describe('openDb', () => {
  it('migrates to the latest schema version', () => {
    db = openDb(':memory:');
    expect(db.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it('creates missing directories and keeps events across reopen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'keryx-db-')), 'a', 'b', 'keryx.db');
    db = openDb(file);
    db.insertEvent(event({ data: { n: 1 } }));
    db.close();
    db = openDb(file);
    expect(db.listEventsSince(0)).toHaveLength(1);
  });
});

describe('events', () => {
  it('stores the envelope and a JSON payload and assigns increasing ids', () => {
    db = openDb(':memory:');
    const first = db.insertEvent(
      event({ issue: 4, repo: 'GravionLabs/keryx', agentId: 'a1', data: { x: [1, 'y'] } }),
    );
    const second = db.insertEvent(event());
    expect(first).toMatchObject({
      id: 1,
      source: 'claude-code',
      type: 'session.idle',
      issue: 4,
      repo: 'GravionLabs/keryx',
      agentId: 'a1',
      data: { x: [1, 'y'] },
    });
    expect(first.at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(second.id).toBe(2);
    expect(db.newestEventId()).toBe(2);
  });

  it('reports newest id 0 for an empty store', () => {
    db = openDb(':memory:');
    expect(db.newestEventId()).toBe(0);
  });

  it('lists events after an id in order, limited', () => {
    db = openDb(':memory:');
    for (let i = 0; i < 5; i++) db.insertEvent(event({ data: { i } }));
    expect(db.listEventsSince(2, 2).map((e) => e.id)).toEqual([3, 4]);
  });

  it('rolls a transaction back on a throw', () => {
    db = openDb(':memory:');
    expect(() =>
      db.transaction(() => {
        db.insertEvent(event());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.newestEventId()).toBe(0);
  });
});

describe('queryEvents', () => {
  it('filters and pages by keyset', () => {
    db = openDb(':memory:');
    db.insertEvent(event({ issue: 1, source: 'a', type: 'x.one' }));
    db.insertEvent(event({ issue: 2, source: 'b', type: 'x.two', agentId: 'ag' }));
    db.insertEvent(event({ issue: 2, source: 'a', type: 'x.one', repo: 'o/r' }));
    const ids = (q: Parameters<Db['queryEvents']>[0]) => db.queryEvents(q).events.map((e) => e.id);
    expect(ids({ limit: 10 })).toEqual([1, 2, 3]);
    expect(ids({ limit: 10, issue: 2 })).toEqual([2, 3]);
    expect(ids({ limit: 10, sources: ['a'] })).toEqual([1, 3]);
    expect(ids({ limit: 10, types: ['x.two', 'x.one'] })).toEqual([1, 2, 3]);
    expect(ids({ limit: 10, agentId: 'ag' })).toEqual([2]);
    expect(ids({ limit: 10, repo: 'o/r' })).toEqual([3]);
    const page = db.queryEvents({ limit: 2 });
    expect(page.next).toBe(2);
    expect(ids({ limit: 2, after: page.next ?? 0 })).toEqual([3]);
    expect(db.queryEvents({ limit: 2, after: 2 }).next).toBeNull();
  });

  it('filters by time range', () => {
    db = openDb(':memory:');
    db.insertEvent(event());
    const now = Date.now();
    const since = new Date(now - 60_000).toISOString();
    const until = new Date(now + 60_000).toISOString();
    expect(db.queryEvents({ limit: 10, since, until }).events).toHaveLength(1);
    expect(db.queryEvents({ limit: 10, until: since }).events).toHaveLength(0);
    expect(db.queryEvents({ limit: 10, since: until }).events).toHaveLength(0);
  });
});
