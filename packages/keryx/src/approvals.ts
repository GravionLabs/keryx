import { z } from 'zod';
import { ATTENTION_SOURCE, type AttentionRecord, ackAttention } from './attention.js';
import type { Db } from './db.js';
import { type BusEvent, REPO_SLUG } from './events/schema.js';
import { ensureGh, gh, requireOk } from './gates/gh.js';

export const APPROVAL_ARMED = 'approval.armed';
export const APPROVAL_FAILED = 'approval.failed';
export const APPROVAL_APPROVE = 'approve';
const PR_MERGED = 'pr.merged';
const CI_FINISHED = 'ci.finished';

/** Pending checks are polled this often, for at most `DEFAULT_MAX_WAIT_MS`. */
export const DEFAULT_RETRY_MS = 30_000;
export const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

const MergeActionSchema = z.object({
  type: z.literal('merge'),
  pr: z.number().int().positive(),
  repo: z.string().regex(REPO_SLUG),
});
export type MergeAction = z.infer<typeof MergeActionSchema>;

const PrViewSchema = z.object({ headRefOid: z.string(), state: z.string() });
const ChecksSchema = z.array(z.object({ name: z.string(), bucket: z.string() }));

/** The merge an `APPROVAL` attention asks for; any other kind or action type is ignored. */
export function mergeActionOf(attention: AttentionRecord): MergeAction | undefined {
  if (attention.kind !== 'APPROVAL') return undefined;
  const parsed = MergeActionSchema.safeParse(attention.action);
  return parsed.success ? parsed.data : undefined;
}

export interface ApprovalsOptions {
  db: Db;
  /** Notifies stream subscribers of an event the approvals wrote. */
  publish: (event: BusEvent) => void;
  log: (message: string) => void;
  /** Working directory of `gh`; every call also passes `--repo`. */
  cwd?: string;
  retryMs?: number;
  maxWaitMs?: number;
}

export interface Approvals {
  /** Pins the PR head of a new merge attention, so a later push cannot ride on the approval. */
  onCreated(attention: AttentionRecord): Promise<void>;
  /** Runs the merge of an answered attention; resolves once it merged, failed or gave up. */
  onAnswered(attention: AttentionRecord): Promise<void>;
  /** Stops retries and waits for running merges. */
  close(): Promise<void>;
}

type Verdict = { merged: string } | { refused: string } | { pending: string };

export function createApprovals(options: ApprovalsOptions): Approvals {
  const { db, publish, log, cwd = process.cwd() } = options;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const running = new Set<Promise<void>>();
  const stop = new AbortController();

  function record(attention: AttentionRecord, type: string, data: Record<string, unknown>): void {
    const event = db.insertEvent({
      source: ATTENTION_SOURCE,
      type,
      agentId: attention.agentId,
      issue: attention.issue,
      repo: attention.repo,
      data,
    });
    try {
      publish(event);
    } catch (error) {
      log(`broadcast of event ${event.id} failed: ${String(error)}`);
    }
  }

  function failed(attention: AttentionRecord, action: MergeAction, reason: string): void {
    log(`approval of attention ${attention.id} failed: ${reason}`);
    record(attention, APPROVAL_FAILED, {
      id: attention.id,
      pr: action.pr,
      repo: action.repo,
      reason,
    });
  }

  async function viewHead(action: MergeAction): Promise<z.infer<typeof PrViewSchema>> {
    const out = requireOk(
      await gh(cwd, [
        'pr',
        'view',
        String(action.pr),
        '--repo',
        action.repo,
        '--json',
        'headRefOid,state',
      ]),
      'gh pr view',
    );
    return PrViewSchema.parse(JSON.parse(out));
  }

  function armedHead(attention: AttentionRecord): string | undefined {
    const { events } = db.queryEvents({
      issue: attention.issue,
      types: [APPROVAL_ARMED],
      sources: [ATTENTION_SOURCE],
      limit: 1000,
    });
    const armed = events.filter((e) => e.data.id === attention.id).at(-1);
    return typeof armed?.data.head === 'string' ? armed.data.head : undefined;
  }

  /** One pass over the rules of `merge`: open PR, head as armed, every required check green. */
  async function attempt(
    attention: AttentionRecord,
    action: MergeAction,
    head: string,
  ): Promise<Verdict> {
    const { pr, repo } = action;
    const view = await viewHead(action);
    if (view.state !== 'OPEN') return { refused: `PR #${pr} is ${view.state}, not OPEN` };
    if (view.headRefOid !== head) {
      return {
        refused: `the head of PR #${pr} changed since the approval was requested (${head} -> ${view.headRefOid})`,
      };
    }
    const res = await gh(cwd, [
      'pr',
      'checks',
      String(pr),
      '--repo',
      repo,
      '--required',
      '--json',
      'name,bucket',
    ]);
    let checks: z.infer<typeof ChecksSchema>;
    try {
      checks = ChecksSchema.parse(JSON.parse(res.stdout));
    } catch {
      return {
        refused: `cannot read the required checks of PR #${pr}: ${res.stderr.trim() || `exit code ${res.exitCode}`}`,
      };
    }
    if (checks.length === 0) return { refused: `PR #${pr} reports no required checks` };
    const pending = checks.filter((c) => c.bucket === 'pending');
    if (pending.length > 0) {
      return {
        pending: `required checks of PR #${pr} are still running: ${pending.map((c) => c.name).join(', ')}`,
      };
    }
    const red = checks.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping');
    record(attention, CI_FINISHED, { pr, commit: head, passed: red.length === 0, checks });
    if (red.length > 0) {
      return {
        refused: `required checks of PR #${pr} are not green: ${red.map((c) => `${c.name} (${c.bucket})`).join(', ')}`,
      };
    }
    requireOk(
      await gh(cwd, [
        'pr',
        'merge',
        String(pr),
        '--repo',
        repo,
        '--squash',
        '--match-head-commit',
        head,
      ]),
      'gh pr merge',
    );
    return { merged: head };
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      stop.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  async function merge(attention: AttentionRecord, action: MergeAction): Promise<void> {
    try {
      await ensureGh(cwd);
      const head = armedHead(attention);
      if (!head) {
        failed(attention, action, `no PR head was recorded when the attention was created`);
        return;
      }
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        const verdict = await attempt(attention, action, head);
        if ('merged' in verdict) {
          record(attention, PR_MERGED, { pr: action.pr, commit: head });
          ackAttention(db, attention.id, 'keryx');
          log(`attention ${attention.id} merged PR #${action.pr}`);
          return;
        }
        if ('refused' in verdict) {
          failed(attention, action, verdict.refused);
          return;
        }
        if (stop.signal.aborted) return;
        if (Date.now() + retryMs > deadline) {
          failed(attention, action, `${verdict.pending}; gave up after ${maxWaitMs / 60_000} min`);
          return;
        }
        await sleep(retryMs);
        if (stop.signal.aborted) return;
      }
    } catch (error) {
      failed(attention, action, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    async onCreated(attention) {
      const action = mergeActionOf(attention);
      if (!action) return;
      try {
        await ensureGh(cwd);
        const { headRefOid } = await viewHead(action);
        record(attention, APPROVAL_ARMED, {
          id: attention.id,
          pr: action.pr,
          repo: action.repo,
          head: headRefOid,
        });
      } catch (error) {
        // no head pinned: an approval later fails instead of merging an unknown commit
        log(`cannot pin the head of PR #${action.pr}: ${String(error)}`);
      }
    },
    onAnswered(attention) {
      const action = mergeActionOf(attention);
      if (!action || attention.answerText !== APPROVAL_APPROVE) return Promise.resolve();
      const run = merge(attention, action).finally(() => running.delete(run));
      running.add(run);
      return run;
    },
    async close() {
      stop.abort();
      await Promise.all(running);
    },
  };
}
