import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { BusEvent, IngestEvent } from './events/schema.js';

/** Applied in order; the index + 1 is the schema version stored in `PRAGMA user_version`. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    at TEXT NOT NULL,
    agent_id TEXT,
    issue INTEGER,
    repo TEXT
  );
  CREATE INDEX idx_events_issue_id ON events(issue, id);
  CREATE INDEX idx_events_type_id ON events(type, id);
  CREATE INDEX idx_events_repo_id ON events(repo, id);
  `,
];

/** Filters for `Db.queryEvents`; absent filters match everything. */
export interface EventQuery {
  issue?: number;
  /** `owner/name` */
  repo?: string;
  types?: string[];
  sources?: string[];
  agentId?: string;
  /** Inclusive lower bound on `at`, normalized ISO UTC. */
  since?: string;
  /** Exclusive upper bound on `at`, normalized ISO UTC. */
  until?: string;
  /** Keyset cursor: only events with id greater than this. */
  after?: number;
  limit: number;
}

export interface EventPage {
  events: BusEvent[];
  /** Id to pass as `after` for the next page; null on the last page. */
  next: number | null;
}

interface EventRow {
  id: number;
  source: string;
  type: string;
  data_json: string;
  at: string;
  agent_id: string | null;
  issue: number | null;
  repo: string | null;
}

function toEvent(row: EventRow): BusEvent {
  return {
    id: row.id,
    at: row.at,
    source: row.source,
    type: row.type,
    agentId: row.agent_id,
    issue: row.issue,
    repo: row.repo,
    data: JSON.parse(row.data_json) as BusEvent['data'],
  };
}

export interface Db {
  insertEvent(event: IngestEvent): BusEvent;
  /** Events with an id above `afterId`, oldest first. */
  listEventsSince(afterId: number, limit?: number): BusEvent[];
  /** Id of the newest event; 0 when the store is empty. */
  newestEventId(): number;
  queryEvents(query: EventQuery): EventPage;
  /** Runs `fn` in one transaction; a throw rolls everything back. */
  transaction<T>(fn: () => T): T;
  schemaVersion(): number;
  close(): void;
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** Opens (and migrates) the event store. `file` is a path or `':memory:'`. */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);

  const insertEvent = db.prepare(
    'INSERT INTO events (source, type, data_json, at, agent_id, issue, repo) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const getEvent = db.prepare<[number | bigint], EventRow>('SELECT * FROM events WHERE id = ?');
  const listEventsSince = db.prepare<[number, number], EventRow>(
    'SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?',
  );
  const newestEventId = db.prepare<[], { id: number | null }>('SELECT MAX(id) AS id FROM events');

  return {
    insertEvent(event) {
      const info = insertEvent.run(
        event.source,
        event.type,
        JSON.stringify(event.data),
        new Date().toISOString(),
        event.agentId,
        event.issue,
        event.repo,
      );
      return toEvent(getEvent.get(info.lastInsertRowid) as EventRow);
    },
    listEventsSince(afterId, limit = 1000) {
      return listEventsSince.all(afterId, limit).map(toEvent);
    },
    newestEventId() {
      return newestEventId.get()?.id ?? 0;
    },
    queryEvents(query) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      const equals = (column: string, value: string | number | undefined): void => {
        if (value !== undefined) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      };
      const oneOf = (column: string, values: string[] | undefined): void => {
        if (values !== undefined) {
          where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
          params.push(...values);
        }
      };
      equals('issue', query.issue);
      equals('repo', query.repo);
      equals('agent_id', query.agentId);
      oneOf('type', query.types);
      oneOf('source', query.sources);
      if (query.since !== undefined) {
        where.push('at >= ?');
        params.push(query.since);
      }
      if (query.until !== undefined) {
        where.push('at < ?');
        params.push(query.until);
      }
      if (query.after !== undefined) {
        where.push('id > ?');
        params.push(query.after);
      }
      const sql = `SELECT * FROM events${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`;
      const rows = db.prepare<(string | number)[], EventRow>(sql).all(...params, query.limit + 1);
      const page = rows.slice(0, query.limit).map(toEvent);
      const last = page[page.length - 1];
      return { events: page, next: rows.length > query.limit && last ? last.id : null };
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
    schemaVersion() {
      return db.pragma('user_version', { simple: true }) as number;
    },
    close() {
      db.close();
    },
  };
}
