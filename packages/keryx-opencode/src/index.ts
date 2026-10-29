import { execFile } from 'node:child_process';

export const SOURCE = 'opencode';
/** Upper bound for one report; a session must never wait noticeably on keryx. */
export const REPORT_BUDGET_MS = 500;
const DEFAULT_URL = 'http://127.0.0.1:4778';

export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface KeryxPluginHooks {
  event?: (input: { event: OpenCodeEvent }) => Promise<void>;
}

export interface PluginInput {
  directory?: string;
  client?: { app?: { log?: (options: { body: Record<string, unknown> }) => unknown } };
}

export interface PluginDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Branch of the worktree at `cwd`; undefined when there is none. */
  branch?: (cwd: string) => Promise<string | undefined>;
  /** Called at most once, with the first failure to reach keryx. */
  log?: (message: string) => void;
  budgetMs?: number;
}

type BusType =
  | 'session.started'
  | 'session.working'
  | 'session.idle'
  | 'session.waiting'
  | 'subagent.finished'
  | 'session.ended';

/** Issue number of a branch named `<type>/<nr>-<slug>`. */
export function issueFromBranch(branch: string | undefined): number | undefined {
  const match = branch?.match(/^[a-z]+\/(\d+)-/);
  if (!match?.[1]) return undefined;
  const nr = Number(match[1]);
  return Number.isSafeInteger(nr) && nr > 0 ? nr : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function busUrl(env: Record<string, string | undefined>): string {
  if (env.KERYX_URL) return env.KERYX_URL.replace(/\/+$/, '');
  return env.KERYX_PORT && /^\d+$/.test(env.KERYX_PORT)
    ? `http://127.0.0.1:${env.KERYX_PORT}`
    : DEFAULT_URL;
}

function defaultBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 300 }, (error, out) => {
      const branch = out.trim();
      resolve(error || branch === '' || branch === 'HEAD' ? undefined : branch);
    });
  });
}

/**
 * OpenCode plugin: posts session state changes to the local keryx bus with the events of the
 * Claude Code hook. It never throws and never waits longer than the budget, whatever goes wrong
 * (keryx not running, bad event): a plugin must not disturb the session. The first failure to
 * reach keryx is logged once.
 */
export const KeryxPlugin = async (
  input: PluginInput = {},
  deps: PluginDeps = {},
): Promise<KeryxPluginHooks> => {
  const env = deps.env ?? process.env;
  const children = new Set<string>();
  let logged = false;
  const log =
    deps.log ??
    ((message: string) => {
      try {
        void Promise.resolve(
          input.client?.app?.log?.({ body: { service: 'keryx', level: 'warn', message } }),
        ).catch(() => {});
      } catch {
        // logging is best effort
      }
    });

  function classify(event: OpenCodeEvent): { type: BusType; sessionId?: string } | undefined {
    const props = obj(event.properties);
    const info = obj(props.info);
    switch (event.type) {
      case 'session.created': {
        const id = str(info.id);
        if (id && str(info.parentID)) {
          children.add(id);
          return undefined;
        }
        return { type: 'session.started', sessionId: id };
      }
      case 'session.status': {
        const id = str(props.sessionID);
        if (obj(props.status).type !== 'busy' || (id && children.has(id))) return undefined;
        return { type: 'session.working', sessionId: id };
      }
      case 'session.idle': {
        const id = str(props.sessionID);
        return {
          type: id && children.has(id) ? 'subagent.finished' : 'session.idle',
          sessionId: id,
        };
      }
      case 'permission.asked':
      case 'question.asked': {
        const id = str(props.sessionID);
        return id && children.has(id) ? undefined : { type: 'session.waiting', sessionId: id };
      }
      case 'session.deleted': {
        const id = str(info.id);
        if (id && children.delete(id)) return undefined;
        return { type: 'session.ended', sessionId: id };
      }
      default:
        return undefined;
    }
  }

  async function report(event: OpenCodeEvent, signal: AbortSignal): Promise<void> {
    const mapped = classify(event);
    if (!mapped) return;
    const cwd = str(obj(obj(event.properties).info).directory) ?? str(input.directory);
    const branch = cwd ? await (deps.branch ?? defaultBranch)(cwd) : undefined;
    const issue = issueFromBranch(branch);
    const { sessionId } = mapped;
    const body = {
      source: SOURCE,
      type: mapped.type,
      ...(sessionId && /^[\w.-]{1,128}$/.test(sessionId) ? { agentId: sessionId } : {}),
      ...(issue !== undefined ? { issue } : {}),
      data: {
        sessionId: sessionId ?? null,
        cwd: cwd ?? null,
        branch: branch ?? null,
        issue: issue ?? null,
        herdrPaneId: str(env.HERDR_PANE_ID) ?? null,
      },
    };
    const res = await (deps.fetch ?? fetch)(`${busUrl(env)}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`keryx answered ${res.status}`);
  }

  return {
    event: async ({ event }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.budgetMs ?? REPORT_BUDGET_MS);
      try {
        await Promise.race([
          report(event, controller.signal),
          new Promise<void>((resolve) =>
            controller.signal.addEventListener('abort', () => resolve()),
          ),
        ]);
      } catch (error) {
        if (!logged) {
          logged = true;
          log(`keryx is not reachable, session state is not reported (${String(error)})`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
