import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BusEventSchema, IngestEventSchema } from './schema.js';

export const EVENTS_SCHEMA_PATH = fileURLToPath(
  new URL('../../schema/events.schema.json', import.meta.url),
);

/** Draft-7 JSON Schema of the stored event (`BusEvent`) and the `POST /ingest` body (`IngestEvent`). */
export function buildEventsSchema(): Record<string, unknown> {
  const options = { target: 'draft-7', io: 'output' } as const;
  const definition = (schema: z.ZodType): Record<string, unknown> => {
    const { $schema: _, ...rest } = z.toJSONSchema(schema, options);
    return rest;
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    definitions: {
      BusEvent: definition(BusEventSchema),
      IngestEvent: definition(IngestEventSchema),
    },
  };
}

export function serializeEventsSchema(): string {
  return `${JSON.stringify(buildEventsSchema(), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(EVENTS_SCHEMA_PATH), { recursive: true });
  writeFileSync(EVENTS_SCHEMA_PATH, serializeEventsSchema());
}
