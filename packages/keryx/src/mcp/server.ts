import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ensureBus, postEvent } from '../gates/bus-client.js';
import { resolveCommit, topLevel } from '../gates/git.js';
import { runGate } from '../gates/run-gate.js';
import { GATE_FINISHED, REVIEW_RECORDED, readGateState } from '../gates/state.js';
import { keryxVersion } from '../version.js';

export const MCP_SOURCE = 'keryx-mcp';

export interface McpDeps {
  /** Bus base URL (`KERYX_URL`, else host and port from the config). */
  busUrl: string;
  /** Directory of the session; its git worktree is gated and reviewed. */
  cwd: string;
  commandTimeoutMs?: number;
}

const FindingSchema = z.strictObject({
  severity: z.enum(['critical', 'important', 'suggestion']),
  file: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1).max(2000),
});

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Wraps a tool body: the bus must be up first, and any error becomes a tool error message. */
function guarded(deps: McpDeps, body: () => Promise<ToolResult>): () => Promise<ToolResult> {
  return async () => {
    try {
      await ensureBus(deps.busUrl);
      return await body();
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

/** The MCP server of one session: `run_gate`, `record_review` and `gate_state`. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'keryx', version: keryxVersion() ?? 'unknown' });

  server.registerTool(
    'run_gate',
    {
      description:
        'Run the gate commands of .agents/config.json (key "gate") in this worktree, in order, stopping at the first failure. keryx runs them itself and records the result for the current commit. Refuses with uncommitted changes or without a gate.',
    },
    async () =>
      guarded(deps, async () => {
        const run = await runGate(deps.cwd, deps.commandTimeoutMs);
        if ('refused' in run) {
          return fail(run.refused);
        }
        const { outcome } = run;
        await postEvent(deps.busUrl, {
          source: MCP_SOURCE,
          type: GATE_FINISHED,
          data: { ...outcome },
        });
        return ok({
          commit: outcome.commit,
          passed: outcome.passed,
          ...(outcome.failedCommand !== undefined
            ? { failedCommand: outcome.failedCommand, outputTail: outcome.outputTail }
            : {}),
        });
      })(),
  );

  server.registerTool(
    'record_review',
    {
      description:
        'Record the review verdict for the current commit (HEAD): approve, or changes with the findings.',
      inputSchema: {
        verdict: z.enum(['approve', 'changes']),
        summary: z.string().min(1).max(5000).optional(),
        findings: z.array(FindingSchema).max(100).default([]),
      },
    },
    async ({ verdict, summary, findings }) =>
      guarded(deps, async () => {
        const commit = await resolveCommit(await topLevel(deps.cwd));
        await postEvent(deps.busUrl, {
          source: MCP_SOURCE,
          type: REVIEW_RECORDED,
          data: { commit, verdict, ...(summary !== undefined ? { summary } : {}), findings },
        });
        return ok({ commit, verdict, findings: findings.length });
      })(),
  );

  server.registerTool(
    'gate_state',
    {
      description: 'Last gate result and last review verdict recorded for a commit (default HEAD).',
      inputSchema: { commit: z.string().min(4).max(64).optional() },
    },
    async ({ commit }) =>
      guarded(deps, async () => {
        const full = await resolveCommit(await topLevel(deps.cwd), commit);
        return ok(await readGateState(deps.busUrl, full));
      })(),
  );

  return server;
}
