import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENTS_SCHEMA_PATH, serializeEventsSchema } from './export-schema.js';
import { BusEventSchema, IngestEventSchema } from './schema.js';

const base = { source: 'claude-code', type: 'session.idle' };

describe('IngestEventSchema', () => {
  it('fills the optional fields', () => {
    expect(IngestEventSchema.parse(base)).toEqual({
      ...base,
      agentId: null,
      issue: null,
      repo: null,
      data: {},
    });
  });

  it.each([
    ['uppercase source', { ...base, source: 'Claude' }],
    ['type with a space', { ...base, type: 'session idle' }],
    ['issue 0', { ...base, issue: 0 }],
    ['bad repo', { ...base, repo: 'no-slash' }],
    ['array data', { ...base, data: [] }],
    ['control character in agentId', { ...base, agentId: 'a‮b' }],
    ['server-owned id', { ...base, id: 1 }],
    ['server-owned at', { ...base, at: '2026-01-01T00:00:00Z' }],
    ['unknown key', { ...base, extra: 1 }],
  ])('rejects %s', (_, event) => {
    expect(IngestEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('PR lifecycle events', () => {
  it.each(['pr.opened', 'ci.finished', 'pr.merged', 'pr.refused'])('accepts %s', (type) => {
    expect(
      IngestEventSchema.safeParse({ source: 'keryx-cli', type, issue: 20, data: { pr: 42 } })
        .success,
    ).toBe(true);
  });
});

describe('BusEventSchema', () => {
  it('accepts a stored event', () => {
    const event = {
      ...base,
      id: 1,
      at: '2026-01-01T00:00:00.000Z',
      agentId: null,
      issue: 4,
      repo: 'GravionLabs/keryx',
      data: { a: 1 },
    };
    expect(BusEventSchema.parse(event)).toEqual(event);
  });
});

describe('events.schema.json', () => {
  it('matches the schemas in code; regenerate with `pnpm run schema`', () => {
    expect(readFileSync(EVENTS_SCHEMA_PATH, 'utf8')).toBe(serializeEventsSchema());
  });
});
