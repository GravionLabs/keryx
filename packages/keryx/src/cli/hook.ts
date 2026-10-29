import { currentBranch } from '../gates/git.js';

/** Claude Code hook event to bus event type. */
export const HOOK_EVENTS = {
  SessionStart: 'session.started',
  UserPromptSubmit: 'session.working',
  Stop: 'session.idle',
  Notification: 'session.waiting',
  SubagentStop: 'subagent.finished',
  SessionEnd: 'session.ended',
} as const;

export type HookEventName = keyof typeof HOOK_EVENTS;

export const HOOK_SOURCE = 'claude-code';
/** Upper bound for the whole hook run; a session must never wait noticeably on keryx. */
export const HOOK_BUDGET_MS = 500;

export interface HookDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Branch of the worktree at `cwd`; undefined when there is none. */
  branch?: (cwd: string) => Promise<string | undefined>;
  budgetMs?: number;
}

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

async function defaultBranch(cwd: string): Promise<string | undefined> {
  try {
    const branch = await currentBranch(cwd);
    return branch === 'HEAD' ? undefined : branch;
  } catch {
    return undefined;
  }
}

async function report(
  event: string,
  readStdin: () => Promise<string>,
  busUrl: () => string,
  deps: HookDeps,
  signal: AbortSignal,
): Promise<void> {
  const type = HOOK_EVENTS[event as HookEventName];
  if (!type) return;
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // an empty or broken payload still reports the event
  }
  const sessionId = str(payload.session_id);
  const cwd = str(payload.cwd);
  const branch = cwd ? await (deps.branch ?? defaultBranch)(cwd) : undefined;
  const issue = issueFromBranch(branch);
  const pane = str((deps.env ?? process.env).HERDR_PANE_ID);
  const body = {
    source: HOOK_SOURCE,
    type,
    ...(sessionId && /^[\w.-]{1,128}$/.test(sessionId) ? { agentId: sessionId } : {}),
    ...(issue !== undefined ? { issue } : {}),
    data: {
      sessionId: sessionId ?? null,
      cwd: cwd ?? null,
      branch: branch ?? null,
      issue: issue ?? null,
      herdrPaneId: pane ?? null,
    },
  };
  await (deps.fetch ?? fetch)(`${busUrl().replace(/\/+$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Runs `keryx hook <event>`: posts the session state change described by the Claude Code hook JSON
 * on `stdin`. Always resolves to 0 and prints nothing, within the budget, whatever goes wrong
 * (bus down, bad payload, unknown event): a hook must never disturb the session.
 */
export async function runHookCommand(
  event: string,
  readStdin: () => Promise<string>,
  busUrl: () => string,
  deps: HookDeps = {},
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.budgetMs ?? HOOK_BUDGET_MS);
  try {
    await Promise.race([
      report(event, readStdin, busUrl, deps, controller.signal),
      new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve())),
    ]);
  } catch {
    // swallowed on purpose, see above
  } finally {
    clearTimeout(timer);
  }
  return 0;
}
