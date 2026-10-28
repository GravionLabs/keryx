import { z } from 'zod';
import { postEvent } from './bus-client.js';
import { ensureGh, gh, requireOk } from './gh.js';
import { currentBranch, resolveCommit, topLevel } from './git.js';
import { type GateState, readGateState } from './state.js';

export const PR_OPENED = 'pr.opened';
export const CI_FINISHED = 'ci.finished';
export const PR_MERGED = 'pr.merged';
export const PR_REFUSED = 'pr.refused';

export const DEFAULT_BASE = 'release/next';

export interface PrContext {
  busUrl: string;
  cwd: string;
  source: string;
}

export interface OpenPrInput {
  title: string;
  body?: string | undefined;
  base?: string | undefined;
  issue?: number | undefined;
}

export type PrAction = { refused: string } | { result: Record<string, unknown> };

/** Why the gate state does not allow a PR for the commit, or null when it does. */
function gateRefusal(state: GateState): string | null {
  if (!state.gate) {
    return `no gate result for ${state.commit}; run run_gate first`;
  }
  if (!state.gate.passed) {
    return `the gate failed for ${state.commit}${state.gate.failedCommand ? ` at \`${state.gate.failedCommand}\`` : ''}`;
  }
  if (!state.review) {
    return `no review recorded for ${state.commit}; review it and call record_review`;
  }
  if (state.review.verdict !== 'approve') {
    return `the review of ${state.commit} asks for changes`;
  }
  return null;
}

async function refuse(
  ctx: PrContext,
  action: 'open_pr' | 'merge',
  reason: string,
  extra: { commit?: string; issue?: number | undefined; pr?: number },
): Promise<{ refused: string }> {
  await postEvent(ctx.busUrl, {
    source: ctx.source,
    type: PR_REFUSED,
    data: {
      action,
      reason,
      ...(extra.commit ? { commit: extra.commit } : {}),
      ...(extra.pr !== undefined ? { pr: extra.pr } : {}),
    },
    ...(extra.issue !== undefined ? { issue: extra.issue } : {}),
  });
  return { refused: reason };
}

/** `https://github.com/o/r/pull/12` → 12. */
function prNumberFrom(output: string): number {
  const match = /\/pull\/(\d+)\s*$/.exec(output.trim());
  if (!match?.[1]) {
    throw new Error(`could not read the PR number from gh output: ${output.trim()}`);
  }
  return Number(match[1]);
}

/**
 * Opens a PR for the current branch into the integration branch, but only when HEAD has a passing
 * `gate.finished` and an approving `review.recorded`. A refusal is recorded as `pr.refused`.
 */
export async function openPr(ctx: PrContext, input: OpenPrInput): Promise<PrAction> {
  const root = await topLevel(ctx.cwd);
  const commit = await resolveCommit(root);
  const state = await readGateState(ctx.busUrl, commit);
  const reason = gateRefusal(state);
  if (reason) {
    return refuse(ctx, 'open_pr', reason, { commit, issue: input.issue });
  }
  const branch = await currentBranch(root);
  if (branch === 'HEAD') {
    return refuse(ctx, 'open_pr', 'HEAD is detached; check out the branch to open a PR for', {
      commit,
      issue: input.issue,
    });
  }
  await ensureGh(root);
  const base = input.base ?? DEFAULT_BASE;
  const out = requireOk(
    await gh(root, [
      'pr',
      'create',
      '--base',
      base,
      '--head',
      branch,
      '--title',
      input.title,
      '--body',
      input.body ?? '',
    ]),
    'gh pr create',
  );
  const pr = prNumberFrom(out);
  await postEvent(ctx.busUrl, {
    source: ctx.source,
    type: PR_OPENED,
    data: { pr, branch, base, commit },
    ...(input.issue !== undefined ? { issue: input.issue } : {}),
  });
  return { result: { pr, url: out.trim(), branch, base, commit } };
}

const ChecksSchema = z.array(z.object({ name: z.string(), bucket: z.string() }));
const PrViewSchema = z.object({ headRefOid: z.string(), state: z.string() });

/**
 * Merges a PR when HEAD is the gated and approved commit, the PR head is HEAD, and every required
 * check is green. The check result is recorded as `ci.finished`; a refusal as `pr.refused`.
 */
export async function mergePr(
  ctx: PrContext,
  input: { pr: number; issue?: number | undefined },
): Promise<PrAction> {
  const root = await topLevel(ctx.cwd);
  const commit = await resolveCommit(root);
  const { pr, issue } = input;
  const state = await readGateState(ctx.busUrl, commit);
  const gateReason = gateRefusal(state);
  if (gateReason) {
    return refuse(ctx, 'merge', gateReason, { commit, issue, pr });
  }
  await ensureGh(root);

  const view = PrViewSchema.parse(
    JSON.parse(
      requireOk(
        await gh(root, ['pr', 'view', String(pr), '--json', 'headRefOid,state']),
        'gh pr view',
      ),
    ),
  );
  if (view.state !== 'OPEN') {
    return refuse(ctx, 'merge', `PR #${pr} is ${view.state}, not OPEN`, { commit, issue, pr });
  }
  if (view.headRefOid !== commit) {
    return refuse(
      ctx,
      'merge',
      `HEAD ${commit} is not the head of PR #${pr} (${view.headRefOid}); push or check out the gated commit`,
      { commit, issue, pr },
    );
  }

  const checksRes = await gh(root, [
    'pr',
    'checks',
    String(pr),
    '--required',
    '--json',
    'name,bucket',
  ]);
  let checks: z.infer<typeof ChecksSchema>;
  try {
    checks = ChecksSchema.parse(JSON.parse(checksRes.stdout));
  } catch {
    // no JSON on stdout: gh failed (no required checks, network, ...)
    const detail = checksRes.stderr.trim() || `exit code ${checksRes.exitCode}`;
    return refuse(ctx, 'merge', `cannot read the required checks of PR #${pr}: ${detail}`, {
      commit,
      issue,
      pr,
    });
  }
  if (checks.length === 0) {
    return refuse(ctx, 'merge', `PR #${pr} reports no required checks`, { commit, issue, pr });
  }
  const pending = checks.filter((c) => c.bucket === 'pending');
  if (pending.length > 0) {
    return refuse(
      ctx,
      'merge',
      `required checks of PR #${pr} are still running: ${pending.map((c) => c.name).join(', ')}`,
      { commit, issue, pr },
    );
  }
  const failed = checks.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping');
  const passed = failed.length === 0;
  await postEvent(ctx.busUrl, {
    source: ctx.source,
    type: CI_FINISHED,
    data: { pr, commit, passed, checks },
    ...(issue !== undefined ? { issue } : {}),
  });
  if (!passed) {
    return refuse(
      ctx,
      'merge',
      `required checks of PR #${pr} are not green: ${failed.map((c) => `${c.name} (${c.bucket})`).join(', ')}`,
      { commit, issue, pr },
    );
  }
  requireOk(await gh(root, ['pr', 'merge', String(pr), '--squash']), 'gh pr merge');
  await postEvent(ctx.busUrl, {
    source: ctx.source,
    type: PR_MERGED,
    data: { pr, commit },
    ...(issue !== undefined ? { issue } : {}),
  });
  return { result: { pr, commit, merged: true } };
}
