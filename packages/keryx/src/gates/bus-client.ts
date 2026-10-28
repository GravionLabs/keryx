import type { BusEvent } from '../events/schema.js';

const TIMEOUT_MS = 5000;

/** The bus is not reachable; the message names `keryx serve`. */
export class BusUnavailableError extends Error {
  constructor(url: string) {
    super(`keryx is not running at ${url}; start it with \`keryx serve\``);
    this.name = 'BusUnavailableError';
  }
}

export interface NewEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
  issue?: number;
  repo?: string;
}

async function call(url: string, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new BusUnavailableError(url);
  }
}

/** Throws BusUnavailableError unless the bus answers `GET /health`. */
export async function ensureBus(url: string): Promise<void> {
  const res = await call(url, '/health');
  if (!res.ok) {
    throw new BusUnavailableError(url);
  }
}

/** Posts one event; resolves to its id. */
export async function postEvent(url: string, event: NewEvent): Promise<number> {
  const res = await call(url, '/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  const body = (await res.json().catch(() => null)) as { ids?: number[]; error?: string } | null;
  if (!res.ok || !body?.ids?.[0]) {
    throw new Error(`keryx rejected the event: ${body?.error ?? `HTTP ${res.status}`}`);
  }
  return body.ids[0];
}

/** All events of the given types, oldest first, following the pages of `GET /events`. */
export async function listEvents(url: string, types: string[]): Promise<BusEvent[]> {
  const events: BusEvent[] = [];
  let after = 0;
  for (;;) {
    const params = new URLSearchParams({
      type: types.join(','),
      limit: '1000',
      after: String(after),
    });
    const res = await call(url, `/events?${params}`);
    const body = (await res.json().catch(() => null)) as {
      events?: BusEvent[];
      next?: number | null;
      error?: string;
    } | null;
    if (!res.ok || !body?.events) {
      throw new Error(`keryx query failed: ${body?.error ?? `HTTP ${res.status}`}`);
    }
    events.push(...body.events);
    if (body.next === null || body.next === undefined || body.next <= after) {
      return events;
    }
    after = body.next;
  }
}
