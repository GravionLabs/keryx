export interface EventOptions {
  issue?: string;
  repo?: string;
  source?: string;
  agentId?: string;
  /** JSON object as text. */
  data?: string;
  /** Bus base URL. */
  url: string;
}

export interface EventDeps {
  fetch?: typeof fetch;
  stderr?: (text: string) => void;
}

export const DEFAULT_SOURCE = 'keryx-cli';
const TIMEOUT_MS = 5000;

/**
 * Runs `keryx event`: posts one event to `POST /ingest`. Resolves to the exit code: 0 on success
 * and when the bus is not running (a notice goes to stderr, so hooks and scripts never fail on
 * it), 2 for bad arguments, 1 when the bus rejects the event.
 */
export async function runEventCommand(
  type: string,
  opts: EventOptions,
  deps: EventDeps = {},
): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const stderr = deps.stderr ?? (() => {});
  let data: unknown = {};
  if (opts.data !== undefined) {
    try {
      data = JSON.parse(opts.data);
    } catch {
      stderr('keryx: --data must be valid JSON');
      return 2;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      stderr('keryx: --data must be a JSON object');
      return 2;
    }
  }
  let issue: number | undefined;
  if (opts.issue !== undefined) {
    issue = Number(opts.issue);
    if (!/^\d+$/.test(opts.issue) || !Number.isSafeInteger(issue) || issue < 1) {
      stderr('keryx: --issue must be a positive integer');
      return 2;
    }
  }
  const event = {
    source: opts.source ?? DEFAULT_SOURCE,
    type,
    data,
    ...(issue !== undefined ? { issue } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
  };
  const base = opts.url.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await doFetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    stderr(`keryx: bus not running at ${base} (start it with \`keryx serve\`); event not sent`);
    return 0;
  }
  if (res.ok) {
    return 0;
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  stderr(`keryx: bus rejected the event: ${detail.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')}`);
  return 1;
}
