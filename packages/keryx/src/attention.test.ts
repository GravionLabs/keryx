import { afterEach, describe, expect, it } from 'vitest';
import {
  ackAttention,
  answerAttention,
  type CreateAttention,
  CreateAttentionSchema,
  createAttention,
  parseAttentionQuery,
} from './attention.js';
import { type Db, openDb } from './db.js';

let db: Db;
afterEach(() => db.close());

const input = (over: Partial<CreateAttention> = {}): CreateAttention => ({
  kind: 'BLOCKED',
  issue: 7,
  summary: 'PBI #7 is blocked',
  ...over,
});

describe('createAttention', () => {
  it('stores an open attention and records attention.created', () => {
    db = openDb(':memory:');
    const { attention, event } = createAttention(
      db,
      input({
        options: ['retry', 'skip'],
        action: { type: 'merge', pr: 123 },
        repo: 'o/r',
        agentId: 'a1',
      }),
    );
    expect(attention).toMatchObject({
      id: 1,
      kind: 'BLOCKED',
      issue: 7,
      state: 'open',
      options: ['retry', 'skip'],
      action: { type: 'merge', pr: 123 },
      repo: 'o/r',
      agentId: 'a1',
      answerText: null,
    });
    expect(event).toMatchObject({
      source: 'keryx',
      type: 'attention.created',
      issue: 7,
      repo: 'o/r',
      agentId: 'a1',
      data: {
        id: 1,
        kind: 'BLOCKED',
        options: ['retry', 'skip'],
        action: { type: 'merge', pr: 123 },
      },
    });
  });

  it('keeps options and action null when absent', () => {
    db = openDb(':memory:');
    expect(createAttention(db, input()).attention).toMatchObject({ options: null, action: null });
  });
});

describe('answerAttention and ackAttention', () => {
  it('moves open -> answered -> acked, one event per step', () => {
    db = openDb(':memory:');
    const { attention } = createAttention(db, input({ options: ['retry', 'skip'] }));
    const answered = answerAttention(db, attention.id, 'skip', 'jerome');
    expect(answered).toMatchObject({
      outcome: 'ok',
      attention: { state: 'answered', answerText: 'skip', answeredBy: 'jerome' },
      event: { type: 'attention.answered', issue: 7, data: { id: 1, text: 'skip', by: 'jerome' } },
    });
    const acked = ackAttention(db, attention.id, null);
    expect(acked).toMatchObject({
      outcome: 'ok',
      attention: { state: 'acked', ackedBy: null },
      event: { type: 'attention.acked', data: { id: 1, by: null } },
    });
    expect(db.queryEvents({ limit: 10 }).events.map((e) => e.type)).toEqual([
      'attention.created',
      'attention.answered',
      'attention.acked',
    ]);
  });

  it('refuses an answer outside the options and leaves the attention open', () => {
    db = openDb(':memory:');
    createAttention(db, input({ options: ['retry', 'skip'] }));
    expect(answerAttention(db, 1, 'abort', 'x')).toEqual({
      outcome: 'invalid',
      error: 'answer must be one of: retry, skip',
    });
    expect(db.getAttention(1)?.state).toBe('open');
    expect(db.queryEvents({ limit: 10 }).events).toHaveLength(1);
  });

  it('accepts free text without options', () => {
    db = openDb(':memory:');
    createAttention(db, input({ kind: 'QUESTION' }));
    expect(answerAttention(db, 1, 'anything', 'x').outcome).toBe('ok');
  });

  it('reports not_found and conflict without recording an event', () => {
    db = openDb(':memory:');
    createAttention(db, input());
    expect(answerAttention(db, 9, 'x', 'y').outcome).toBe('not_found');
    expect(ackAttention(db, 1, null).outcome).toBe('conflict');
    answerAttention(db, 1, 'x', 'y');
    expect(answerAttention(db, 1, 'x', 'y').outcome).toBe('conflict');
    ackAttention(db, 1, 'z');
    expect(ackAttention(db, 1, 'z').outcome).toBe('conflict');
    expect(db.queryEvents({ limit: 10 }).events).toHaveLength(3);
  });
});

describe('listAttention', () => {
  it('filters by state, kind, issue and since, oldest first', () => {
    db = openDb(':memory:');
    createAttention(db, input({ issue: 1 }));
    createAttention(db, input({ issue: 2, kind: 'APPROVAL' }));
    createAttention(db, input({ issue: 2, kind: 'QUESTION' }));
    answerAttention(db, 2, 'x', 'y');
    const ids = (q: Parameters<Db['listAttention']>[0]) => db.listAttention(q).map((a) => a.id);
    expect(ids({ limit: 10 })).toEqual([1, 2, 3]);
    expect(ids({ limit: 10, state: 'open' })).toEqual([1, 3]);
    expect(ids({ limit: 10, state: 'answered' })).toEqual([2]);
    expect(ids({ limit: 10, kind: 'QUESTION' })).toEqual([3]);
    expect(ids({ limit: 10, issue: 2 })).toEqual([2, 3]);
    expect(ids({ limit: 10, since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
    expect(ids({ limit: 2 })).toEqual([1, 2]);
  });
});

describe('CreateAttentionSchema', () => {
  it.each([
    [{ kind: 'GATE', issue: 1, summary: 's' }],
    [{ kind: 'BLOCKED', summary: 's' }],
    [{ kind: 'BLOCKED', issue: 0, summary: 's' }],
    [{ kind: 'BLOCKED', issue: 1, summary: '' }],
    [{ kind: 'BLOCKED', issue: 1, summary: 'a‮b' }],
    [{ kind: 'BLOCKED', issue: 1, summary: 's', options: [] }],
    [{ kind: 'BLOCKED', issue: 1, summary: 's', options: Array(17).fill('x') }],
    [{ kind: 'BLOCKED', issue: 1, summary: 's', action: 'merge' }],
    [{ kind: 'BLOCKED', issue: 1, summary: 's', extra: 1 }],
  ])('rejects %j', (body) => {
    expect(CreateAttentionSchema.safeParse(body).success).toBe(false);
  });
});

describe('parseAttentionQuery', () => {
  const parse = (q: string) => parseAttentionQuery(new URLSearchParams(q));

  it('parses every filter', () => {
    expect(parse('state=open&kind=BLOCKED&issue=3&since=2026-10-29T10:00Z&limit=5')).toEqual({
      query: {
        state: 'open',
        kind: 'BLOCKED',
        issue: 3,
        since: '2026-10-29T10:00:00.000Z',
        limit: 5,
      },
    });
    expect(parse('')).toEqual({ query: { limit: 100 } });
  });

  it.each([
    ['state=done', /state must be/],
    ['kind=GATE', /kind must be/],
    ['issue=x', /issue must be/],
    ['limit=0', /limit must be/],
    ['limit=1001', /limit must be/],
    ['since=yesterday', /since must be/],
    ['foo=1', /unknown parameter: foo/],
    ['state=open&state=answered', /repeated parameter: state/],
  ])('rejects %s', (q, message) => {
    expect(parse(q)).toEqual({ error: expect.stringMatching(message) });
  });
});
