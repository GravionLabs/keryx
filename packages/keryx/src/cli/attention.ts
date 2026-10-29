import { userInfo } from 'node:os';
import type { AttentionRecord } from '../attention.js';

export interface AttentionDeps {
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Value of `--by` when it is not given. */
  user?: () => string;
}

interface Io {
  doFetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  user: () => string;
}

const TIMEOUT_MS = 5000;

function io(deps: AttentionDeps): Io {
  return {
    doFetch: deps.fetch ?? fetch,
    stdout: deps.stdout ?? (() => {}),
    stderr: deps.stderr ?? (() => {}),
    user:
      deps.user ??
      (() => {
        try {
          return userInfo().username || 'cli';
        } catch {
          return 'cli';
        }
      }),
  };
}

type Reply = { status: number; body: unknown } | 'down';

async function call(
  { doFetch }: Io,
  base: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Reply> {
  try {
    const res = await doFetch(`${base.replace(/\/+$/, '')}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return 'down';
  }
}

function clean(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/** Prints the bus's error and returns exit code 1. */
function rejected(io: Io, reply: { status: number; body: unknown }): number {
  const error = (reply.body as { error?: unknown } | null)?.error;
  io.stderr(`keryx: ${clean(typeof error === 'string' ? error : `HTTP ${reply.status}`)}`);
  return 1;
}

function down(io: Io, base: string): void {
  io.stderr(`keryx: bus not running at ${base} (start it with \`keryx serve\`)`);
}

function positive(name: string, value: string | undefined, io: Io): number | undefined | 'bad' {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (/^\d+$/.test(value) && Number.isSafeInteger(n) && n >= 1) return n;
  io.stderr(`keryx: ${name} must be a positive integer`);
  return 'bad';
}

export interface CreateOptions {
  kind: string;
  issue: string;
  summary: string;
  option?: string[];
  /** JSON object as text. */
  action?: string;
  repo?: string;
  agentId?: string;
  url: string;
}

/**
 * `keryx attention create`: posts an attention and prints its id. Exit 0 without an id and with a
 * notice on stderr when the bus is not running, so a producer never fails on a missing keryx;
 * 2 for bad arguments, 1 when the bus rejects the attention.
 */
export async function runAttentionCreate(
  opts: CreateOptions,
  deps: AttentionDeps = {},
): Promise<number> {
  const o = io(deps);
  const issue = positive('--issue', opts.issue, o);
  if (issue === 'bad') return 2;
  let action: unknown;
  if (opts.action !== undefined) {
    try {
      action = JSON.parse(opts.action);
    } catch {
      o.stderr('keryx: --action must be valid JSON');
      return 2;
    }
    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
      o.stderr('keryx: --action must be a JSON object');
      return 2;
    }
  }
  const reply = await call(o, opts.url, 'POST', '/attention', {
    kind: opts.kind,
    issue,
    summary: opts.summary,
    ...(opts.option?.length ? { options: opts.option } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
  });
  if (reply === 'down') {
    o.stderr(
      `keryx: bus not running at ${opts.url} (start it with \`keryx serve\`); attention not created`,
    );
    return 0;
  }
  if (reply.status !== 201) return rejected(o, reply);
  o.stdout(String((reply.body as AttentionRecord).id));
  return 0;
}

export interface ListOptions {
  state?: string;
  kind?: string;
  issue?: string;
  since?: string;
  limit?: string;
  json?: boolean;
  url: string;
}

function line(a: AttentionRecord): string {
  const answer = a.answerText === null ? '' : ` -> ${a.answerText}`;
  return `${a.id}\t${a.state}\t${a.kind}\t#${a.issue}\t${clean(a.summary)}${clean(answer)}`;
}

/** `keryx attention list`: one line per attention, or the JSON array with `--json`. */
export async function runAttentionList(
  opts: ListOptions,
  deps: AttentionDeps = {},
): Promise<number> {
  const o = io(deps);
  const params = new URLSearchParams();
  for (const name of ['state', 'kind', 'issue', 'since', 'limit'] as const) {
    const value = opts[name];
    if (value !== undefined) params.set(name, value);
  }
  const query = params.size > 0 ? `?${params}` : '';
  const reply = await call(o, opts.url, 'GET', `/attention${query}`);
  if (reply === 'down') {
    down(o, opts.url);
    return 1;
  }
  if (reply.status !== 200) return rejected(o, reply);
  const list = (reply.body as { attention: AttentionRecord[] }).attention;
  if (opts.json) o.stdout(JSON.stringify(list));
  else for (const a of list) o.stdout(line(a));
  return 0;
}

export interface AnswerOptions {
  by?: string;
  url: string;
}

/** `keryx attention answer <id> <text>`: `text` must be one of the attention's options, if any. */
export async function runAttentionAnswer(
  id: string,
  text: string,
  opts: AnswerOptions,
  deps: AttentionDeps = {},
): Promise<number> {
  const o = io(deps);
  if (positive('<id>', id, o) === 'bad') return 2;
  const reply = await call(o, opts.url, 'POST', `/attention/${id}/answer`, {
    text,
    by: opts.by ?? o.user(),
  });
  if (reply === 'down') {
    down(o, opts.url);
    return 1;
  }
  return reply.status === 200 ? 0 : rejected(o, reply);
}

/** `keryx attention ack <id>`: marks an answered attention as taken over by its consumer. */
export async function runAttentionAck(
  id: string,
  opts: AnswerOptions,
  deps: AttentionDeps = {},
): Promise<number> {
  const o = io(deps);
  if (positive('<id>', id, o) === 'bad') return 2;
  const reply = await call(o, opts.url, 'POST', `/attention/${id}/ack`, {
    by: opts.by ?? o.user(),
  });
  if (reply === 'down') {
    down(o, opts.url);
    return 1;
  }
  return reply.status === 200 ? 0 : rejected(o, reply);
}
