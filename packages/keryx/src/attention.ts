import { z } from 'zod';
import type { Db } from './db.js';
import { intParam, rejectUnknownOrRepeated, timeParam } from './event-query.js';
import { type BusEvent, BusEventSchema, text } from './events/schema.js';

export const ATTENTION_SOURCE = 'keryx';
export const ATTENTION_KINDS = ['BLOCKED', 'APPROVAL', 'QUESTION'] as const;
export const ATTENTION_STATES = ['open', 'answered', 'acked'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export type AttentionState = (typeof ATTENTION_STATES)[number];

const MAX_OPTIONS = 16;

/** What a producer sends to `POST /attention`. */
export const CreateAttentionSchema = z.strictObject({
  kind: z.enum(ATTENTION_KINDS),
  issue: BusEventSchema.shape.issue.unwrap(),
  summary: text(1, 2000),
  /** The only answers accepted; absent means free text. */
  options: z.array(text(1, 200)).min(1).max(MAX_OPTIONS).optional(),
  /** Data for a consumer, for example `{ "type": "merge", "pr": 123 }`. */
  action: z.record(z.string(), z.unknown()).optional(),
  repo: BusEventSchema.shape.repo.optional(),
  agentId: BusEventSchema.shape.agentId.optional(),
});
export type CreateAttention = z.infer<typeof CreateAttentionSchema>;

export const AnswerBodySchema = z.strictObject({ text: text(1, 4000), by: text(1, 128) });
export const AckBodySchema = z.strictObject({ by: text(1, 128).optional() });

export interface AttentionRecord {
  id: number;
  kind: AttentionKind;
  issue: number;
  repo: string | null;
  agentId: string | null;
  summary: string;
  options: string[] | null;
  action: Record<string, unknown> | null;
  state: AttentionState;
  createdAt: string;
  answerText: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  ackedBy: string | null;
  ackedAt: string | null;
}

/** Filters for `Db.listAttention`; absent filters match everything. */
export interface AttentionQuery {
  state?: AttentionState;
  kind?: AttentionKind;
  issue?: number;
  /** Inclusive lower bound on `createdAt`, normalized ISO UTC. */
  since?: string;
  limit: number;
}

export const DEFAULT_ATTENTION_LIMIT = 100;
export const MAX_ATTENTION_LIMIT = 1000;
const QUERY_KEYS = new Set(['state', 'kind', 'issue', 'since', 'limit']);

export type ParsedAttentionQuery = { query: AttentionQuery } | { error: string };

/** Validates the `GET /attention` query string; the error text names the offending parameter. */
export function parseAttentionQuery(params: URLSearchParams): ParsedAttentionQuery {
  const keyError = rejectUnknownOrRepeated(params, QUERY_KEYS);
  if (keyError !== undefined) return { error: keyError };
  const query: AttentionQuery = { limit: DEFAULT_ATTENTION_LIMIT };
  const state = params.get('state');
  if (state !== null) {
    const match = ATTENTION_STATES.find((s) => s === state);
    if (!match) return { error: `state must be one of ${ATTENTION_STATES.join(', ')}` };
    query.state = match;
  }
  const kind = params.get('kind');
  if (kind !== null) {
    const match = ATTENTION_KINDS.find((k) => k === kind);
    if (!match) return { error: `kind must be one of ${ATTENTION_KINDS.join(', ')}` };
    query.kind = match;
  }
  for (const name of ['issue', 'limit'] as const) {
    const raw = params.get(name);
    if (raw === null) continue;
    const n = intParam(name, raw);
    if (typeof n === 'string') return { error: n };
    if (name === 'limit') {
      if (n < 1 || n > MAX_ATTENTION_LIMIT) {
        return { error: `limit must be an integer between 1 and ${MAX_ATTENTION_LIMIT}` };
      }
      query.limit = n;
    } else {
      query.issue = n;
    }
  }
  const since = params.get('since');
  if (since !== null) {
    const t = timeParam('since', since);
    if (typeof t === 'string') return { error: t };
    query.since = t.iso;
  }
  return { query };
}

/** Outcome of a state transition; `ok` carries the new record and its lifecycle event. */
export type AttentionTransition =
  | { outcome: 'ok'; attention: AttentionRecord; event: BusEvent }
  | { outcome: 'not_found' }
  | { outcome: 'conflict' }
  | { outcome: 'invalid'; error: string };

function lifecycleEvent(
  db: Db,
  attention: AttentionRecord,
  type: string,
  data: Record<string, unknown>,
): BusEvent {
  return db.insertEvent({
    source: ATTENTION_SOURCE,
    type,
    agentId: attention.agentId,
    issue: attention.issue,
    repo: attention.repo,
    data,
  });
}

/** Stores an open attention and its `attention.created` event in one transaction. */
export function createAttention(
  db: Db,
  input: CreateAttention,
): { attention: AttentionRecord; event: BusEvent } {
  return db.transaction(() => {
    const attention = db.insertAttention(input);
    const event = lifecycleEvent(db, attention, 'attention.created', {
      id: attention.id,
      kind: attention.kind,
      summary: attention.summary,
      options: attention.options,
      action: attention.action,
    });
    return { attention, event };
  });
}

/**
 * Compare-and-set `open -> answered` and `attention.answered` in one transaction: a failing event
 * insert leaves the attention open. An answer outside `options` is `invalid`.
 */
export function answerAttention(
  db: Db,
  id: number,
  answerText: string,
  by: string,
): AttentionTransition {
  return db.transaction(() => {
    const current = db.getAttention(id);
    if (current?.options && !current.options.includes(answerText)) {
      return { outcome: 'invalid', error: `answer must be one of: ${current.options.join(', ')}` };
    }
    const outcome = db.answerAttention(id, answerText, by);
    if (outcome !== 'ok') return { outcome };
    const attention = db.getAttention(id) as AttentionRecord;
    const event = lifecycleEvent(db, attention, 'attention.answered', { id, text: answerText, by });
    return { outcome: 'ok', attention, event };
  });
}

/** Compare-and-set `answered -> acked` and `attention.acked` in one transaction. */
export function ackAttention(db: Db, id: number, by: string | null): AttentionTransition {
  return db.transaction(() => {
    const outcome = db.ackAttention(id, by);
    if (outcome !== 'ok') return { outcome };
    const attention = db.getAttention(id) as AttentionRecord;
    const event = lifecycleEvent(db, attention, 'attention.acked', { id, by });
    return { outcome: 'ok', attention, event };
  });
}
