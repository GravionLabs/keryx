import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, parseEventQuery } from './event-query.js';

const parse = (qs: string) => parseEventQuery(new URLSearchParams(qs));

describe('parseEventQuery', () => {
  it('defaults to the default limit', () => {
    expect(parse('')).toEqual({ query: { limit: DEFAULT_QUERY_LIMIT } });
  });

  it('parses every filter', () => {
    const since = '2026-01-01T00:00:00Z';
    expect(
      parse(
        `issue=4&repo=o/r&type=a,b&source=s&agentId=x&since=${since}&until=${since}&after=7&limit=5`,
      ),
    ).toEqual({
      query: {
        issue: 4,
        repo: 'o/r',
        types: ['a', 'b'],
        sources: ['s'],
        agentId: 'x',
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-01-01T00:00:00.000Z',
        after: 7,
        limit: 5,
      },
    });
  });

  it.each([
    ['unknown=1', 'unknown parameter: unknown'],
    ['issue=1&issue=2', 'repeated parameter: issue'],
    ['issue=-1', 'issue must be a non-negative integer'],
    ['after=x', 'after must be a non-negative integer'],
    ['limit=0', 'limit must be an integer between 1 and 1000'],
    [`limit=${MAX_QUERY_LIMIT + 1}`, 'limit must be an integer between 1 and 1000'],
    ['type=a,,b', 'type must be a comma-separated list without empty entries'],
    ['repo=nope', 'repo must be owner/name'],
    ['agentId=', 'agentId must not be empty'],
    ['since=yesterday', 'since must be an ISO-8601 date-time (YYYY-MM-DDTHH:MM...)'],
  ])('rejects %s', (qs, error) => {
    expect(parse(qs)).toEqual({ error });
  });
});
