import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { z } from 'zod';
import { BusEvents } from './bus-events.js';
import { type BusLog, createBusLog } from './bus-log.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { parseEventQuery } from './event-query.js';
import { createEventStream, createHostGuard } from './event-stream.js';
import { type IngestEvent, IngestEventSchema } from './events/schema.js';

export interface HttpOptions {
  config: Config;
  db: Db;
  /** Directory of `bus.log`. */
  stateDir: string;
  /** Wake-up channel for the event stream; created when omitted. */
  events?: BusEvents;
  /** Human-readable log; defaults to `<stateDir>/bus.log`. */
  log?: BusLog;
  /** Heartbeat interval of `GET /events/stream` in ms; defaults to 15 s. */
  heartbeatMs?: number;
  /** Concurrent `GET /events/stream` connections; defaults to 64. */
  maxEventStreams?: number;
  /** Live backlog in bytes after which a slow stream client is disconnected; defaults to 1 MiB. */
  maxStreamBufferedBytes?: number;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Largest `POST /ingest` body in bytes; bigger bodies get 413. */
export const MAX_INGEST_BODY_BYTES = 1024 * 1024;
/** Most events in one `POST /ingest` array; longer arrays get 413. */
export const MAX_INGEST_BATCH = 100;
/** Body bytes discarded after a 413 before the connection is closed instead. */
const MAX_DRAIN_BYTES = 8 * MAX_INGEST_BODY_BYTES;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Request body over the cap given to `readJson`. */
class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body over ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Event listeners rather than `for await`: leaving an async iterator early destroys the request
  // and with it the socket, so an over-cap client would never see its 413.
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.pause();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => resolve(Buffer.concat(chunks).toString('utf8'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', reject);
  });
  return raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

/** A request with an Origin (a browser) must declare application/json; others may send any. */
function browserContentTypeAllowed(req: IncomingMessage): boolean {
  if (req.headers.origin === undefined) {
    return true;
  }
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  return contentType === 'application/json';
}

/**
 * 413 for an oversized body. The rest of the body is drained unparsed and the reply written once
 * it ends, so the client reads the 413 instead of a reset and a keep-alive connection stays
 * usable. A body still going after `MAX_DRAIN_BYTES` gets the 413 with `Connection: close`.
 */
function sendTooLarge(req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify({ error: `body over ${MAX_INGEST_BODY_BYTES} bytes` });
  const reply = (close: boolean): void => {
    if (res.headersSent) {
      return;
    }
    res.writeHead(413, {
      'content-type': 'application/json',
      ...(close ? { connection: 'close' } : {}),
    });
    res.end(body);
  };
  if (req.complete) {
    reply(false);
    return;
  }
  let drained = 0;
  const onData = (chunk: Buffer): void => {
    drained += chunk.length;
    if (drained > MAX_DRAIN_BYTES) {
      req.off('data', onData);
      reply(true);
    }
  };
  req.on('data', onData);
  req.once('end', () => reply(false));
  req.resume();
}

/** First schema issue as a short message; never echoes the whole error or the input. */
function briefIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.join('.') || '(root)';
  return `${where}: ${issue?.message ?? 'invalid'}`.slice(0, 200);
}

export async function startHttp({
  config,
  db,
  stateDir,
  events = new BusEvents(),
  log = createBusLog(stateDir),
  heartbeatMs,
  maxEventStreams,
  maxStreamBufferedBytes,
}: HttpOptions): Promise<RunningHttp> {
  const { host, port } = config;
  const eventStream = createEventStream({
    db,
    events,
    log,
    heartbeatMs,
    maxStreams: maxEventStreams,
    maxBufferedBytes: maxStreamBufferedBytes,
    allowedHosts: [host],
  });
  const hostAllowed = createHostGuard([host]);

  function handleEventQuery(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    const parsed = parseEventQuery(new URL(req.url ?? '/', 'http://localhost').searchParams);
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    sendJson(res, 200, db.queryEvents(parsed.query));
  }

  /**
   * `POST /ingest`: one event or a non-empty array from an external producer, all-or-nothing.
   * Rows are committed first and published synchronously right after the commit, in id order,
   * before the 202 is written; publishing only queues frames, so a slow subscriber never blocks
   * the reply. A stream deduplicates by event id, so a replay and a live publish never deliver
   * the same event twice.
   */
  async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden host or origin' });
      return;
    }
    // The Host/Origin guard above is the cross-origin defence. Callers without an Origin (curl,
    // hooks, scripts) may send any or no Content-Type; the body is parsed as JSON regardless.
    // A browser request (it always sends Origin) must still be application/json, which a page
    // cannot send cross-origin without a CORS preflight.
    if (!browserContentTypeAllowed(req)) {
      sendJson(res, 415, { error: 'content-type must be application/json' });
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_INGEST_BODY_BYTES) {
      sendTooLarge(req, res);
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, MAX_INGEST_BODY_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendTooLarge(req, res);
      } else {
        sendJson(res, 400, { error: 'invalid JSON body' });
      }
      return;
    }
    const items: unknown[] = Array.isArray(body) ? body : [body];
    if (items.length === 0) {
      sendJson(res, 400, { error: 'empty batch' });
      return;
    }
    if (items.length > MAX_INGEST_BATCH) {
      sendJson(res, 413, { error: `batch over ${MAX_INGEST_BATCH} events` });
      return;
    }
    // id and at are server-owned: an event carrying them is rejected by the strict schema.
    const accepted: IngestEvent[] = [];
    for (const [i, item] of items.entries()) {
      const checked = IngestEventSchema.safeParse(item);
      if (!checked.success) {
        sendJson(res, 400, { error: `item ${i}: ${briefIssue(checked.error)}` });
        return;
      }
      accepted.push(checked.data);
    }
    // Persist first; subscribers are notified only after the commit.
    const rows = db.transaction(() => accepted.map((e) => db.insertEvent(e)));
    // Synchronously, in id order: a deferred publish could arrive after a higher id another
    // write published meanwhile, and a stream (cursor already past it) would drop it.
    for (const row of rows) {
      try {
        events.publishEvent(row);
      } catch (error) {
        log.logLine('ERROR', `ingest broadcast of event ${row.id} failed: ${String(error)}`);
      }
    }
    const shown = accepted.slice(0, 5).map((e) => `${e.source} ${e.type}`);
    log.logLine(
      'INGEST',
      `${accepted.length} event(s): ${shown.join(', ')}${accepted.length > shown.length ? ', ...' : ''}`,
    );
    sendJson(res, 202, { ids: rows.map((r) => r.id) });
  }

  const fail = (res: ServerResponse) => (error: unknown) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
    } else if (path === '/events/stream') {
      eventStream.handle(req, res).catch(fail(res));
    } else if (path === '/ingest') {
      handleIngest(req, res).catch(fail(res));
    } else if (path === '/events') {
      Promise.resolve()
        .then(() => handleEventQuery(req, res))
        .catch(fail(res));
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const urlHost = host.includes(':') ? `[${host}]` : host;

  return {
    server,
    url: `http://${urlHost}:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
