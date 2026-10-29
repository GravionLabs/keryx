import { z } from 'zod';

// Free text from external producers must not carry characters that break or spoof rendering:
// control characters, bidi controls, zero-width characters, line and paragraph separators and the
// BOM. The set is explicit (not `\p{Cf}`) so it cannot drift with the Unicode version. The check is
// a refinement, so it is not part of the exported JSON Schema.
export const FORBIDDEN_CHARS =
  /[\p{Cc}\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/u;

export const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (s) => !FORBIDDEN_CHARS.test(s),
      'control or invisible formatting characters are not allowed',
    );

export const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

/**
 * An event on the bus. `source` and `type` are labels chosen by the producer (for example
 * `claude-code` and `session.idle`), not authenticated identities. The type vocabulary belongs to
 * the producers; the bus only checks the shape.
 */
export const BusEventSchema = z.strictObject({
  /** Row id, assigned by the bus on insert. */
  id: z.number().int(),
  at: z.iso.datetime(),
  source: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9._/-]*$/),
  type: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9._:-]*$/),
  agentId: text(1, 128).nullable(),
  issue: z.number().int().positive().nullable(),
  repo: z.string().max(200).regex(REPO_SLUG).nullable(),
  data: z.record(z.string(), z.unknown()),
});

export type BusEvent = z.infer<typeof BusEventSchema>;

/** What a producer sends to `POST /ingest`: `id` and `at` are server-owned, the rest is optional. */
export const IngestEventSchema = z.strictObject({
  source: BusEventSchema.shape.source,
  type: BusEventSchema.shape.type,
  agentId: BusEventSchema.shape.agentId.default(null),
  issue: BusEventSchema.shape.issue.default(null),
  repo: BusEventSchema.shape.repo.default(null),
  data: BusEventSchema.shape.data.default({}),
});

export type IngestEvent = z.infer<typeof IngestEventSchema>;
