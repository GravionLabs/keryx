import { Command, CommanderError } from 'commander';
import { busUrl, ConfigError, loadConfig } from '../config.js';
import { type RunningServe, reportStartupError, serve } from '../serve.js';
import { keryxVersion } from '../version.js';
import {
  type CreateOptions,
  type ListOptions,
  runAttentionAck,
  runAttentionAnswer,
  runAttentionCreate,
  runAttentionList,
} from './attention.js';
import { runEventCommand } from './event.js';
import { runHookCommand } from './hook.js';
import { InstallError, runInstallClaude } from './install.js';
import { runMcpCommand } from './mcp.js';

export interface CliHooks {
  /** Called with the running server after `serve` started (lets tests close it). */
  onServe?: (running: RunningServe) => void;
}

export function buildProgram(
  onResult: (code: number) => void = () => {},
  hooks: CliHooks = {},
): Command {
  const program = new Command('keryx')
    .description('Local event bus for Claude Code and OpenCode sessions')
    .version(keryxVersion() ?? 'unknown', '-V, --version')
    .exitOverride();

  program
    .command('serve')
    .description('start the bus (/ingest, /events, /events/stream, /health) in the foreground')
    .action(async () => {
      let config: ReturnType<typeof loadConfig> | undefined;
      try {
        config = loadConfig();
        const running = await serve(config);
        hooks.onServe?.(running);
      } catch (error) {
        if (!reportStartupError(error, config)) throw error;
        onResult(1);
      }
    });

  program
    .command('event')
    .description('post one event to the bus (POST /ingest); exits 0 when the bus is not running')
    .argument('<type>', 'event type, e.g. session.idle')
    .option('--issue <nr>', 'issue number')
    .option('--repo <owner/name>', 'repository')
    .option('--source <name>', 'event source (default keryx-cli)')
    .option('--agent-id <id>', 'agent id')
    .option('--data <json>', 'event data as a JSON object')
    .option('--url <base>', 'bus base URL (default KERYX_URL, else host and port from config)')
    .action(async (type: string, opts: Record<string, string | undefined>) => {
      const { url, agentId, ...rest } = opts;
      try {
        onResult(
          await runEventCommand(
            type,
            { ...rest, agentId, url: url ?? busUrl() },
            { stderr: (t) => process.stderr.write(`${t}\n`) },
          ),
        );
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        process.stderr.write(`keryx: ${error.message}\n`);
        onResult(1);
      }
    });

  const attention = program
    .command('attention')
    .description('questions that wait for a human: create, list, answer, ack');
  const attentionIo = {
    stdout: (t: string) => process.stdout.write(`${t}\n`),
    stderr: (t: string) => process.stderr.write(`${t}\n`),
  };
  const urlOption = '--url <base>';
  const urlHelp = 'bus base URL (default KERYX_URL, else host and port from config)';
  const attentionAction =
    <A extends unknown[]>(run: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      try {
        onResult(await run(...args));
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        process.stderr.write(`keryx: ${error.message}\n`);
        onResult(1);
      }
    };

  attention
    .command('create')
    .description('create an attention and print its id; exits 0 when the bus is not running')
    .requiredOption('--kind <kind>', 'BLOCKED, APPROVAL or QUESTION')
    .requiredOption('--issue <nr>', 'issue number')
    .requiredOption('--summary <text>', 'what the human has to decide')
    .option('--option <text>', 'an allowed answer (repeatable)', (v, all: string[] = []) => [
      ...all,
      v,
    ])
    .option('--action <json>', 'data for the consumer, a JSON object, e.g. {"type":"merge","pr":1}')
    .option('--repo <owner/name>', 'repository')
    .option('--agent-id <id>', 'agent id')
    .option(urlOption, urlHelp)
    .action(
      attentionAction(async (opts: Omit<CreateOptions, 'url'> & { url?: string }) =>
        runAttentionCreate({ ...opts, url: opts.url ?? busUrl() }, attentionIo),
      ),
    );

  attention
    .command('list')
    .description('list attentions, oldest first')
    .option('--state <state>', 'open, answered or acked')
    .option('--kind <kind>', 'BLOCKED, APPROVAL or QUESTION')
    .option('--issue <nr>', 'issue number')
    .option('--since <iso>', 'created at or after')
    .option('--limit <n>', 'at most n (default 100)')
    .option('--json', 'print the JSON array')
    .option(urlOption, urlHelp)
    .action(
      attentionAction(async (opts: Omit<ListOptions, 'url'> & { url?: string }) =>
        runAttentionList({ ...opts, url: opts.url ?? busUrl() }, attentionIo),
      ),
    );

  attention
    .command('answer')
    .description('answer an open attention; the text must be one of its options, if it has any')
    .argument('<id>', 'attention id')
    .argument('<text>', 'the answer')
    .option('--by <name>', 'who answers (default: the login name)')
    .option(urlOption, urlHelp)
    .action(
      attentionAction(async (id: string, text: string, opts: { by?: string; url?: string }) =>
        runAttentionAnswer(id, text, { by: opts.by, url: opts.url ?? busUrl() }, attentionIo),
      ),
    );

  attention
    .command('ack')
    .description('acknowledge an answered attention')
    .argument('<id>', 'attention id')
    .option('--by <name>', 'who acknowledges (default: the login name)')
    .option(urlOption, urlHelp)
    .action(
      attentionAction(async (id: string, opts: { by?: string; url?: string }) =>
        runAttentionAck(id, { by: opts.by, url: opts.url ?? busUrl() }, attentionIo),
      ),
    );

  program
    .command('mcp')
    .description(
      'start the MCP server of this session on stdio (run_gate, record_review, gate_state)',
    )
    .action(async () => {
      try {
        await runMcpCommand({ busUrl: busUrl(), cwd: process.cwd() });
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        process.stderr.write(`keryx: ${error.message}\n`);
        onResult(1);
      }
    });

  program
    .command('hook')
    .description(
      'report Claude Code session state from a hook (JSON on stdin); always exits 0, silently',
    )
    .argument('<event>', 'hook event, e.g. SessionStart, Stop')
    .action(async (event: string) => {
      onResult(
        await runHookCommand(event, readStdin, busUrl, {
          budgetMs: process.env.KERYX_HOOK_BUDGET_MS
            ? Number(process.env.KERYX_HOOK_BUDGET_MS)
            : undefined,
        }),
      );
    });

  program
    .command('install')
    .description('register the keryx hooks with a harness (claude)')
    .argument('<harness>', 'claude')
    .option('--project', 'write .claude/settings.json of the current directory')
    .option('--uninstall', 'remove the keryx hooks only')
    .action((harness: string, opts: { project?: boolean; uninstall?: boolean }) => {
      if (harness !== 'claude') {
        process.stderr.write(`keryx: unknown harness "${harness}" (supported: claude)\n`);
        onResult(2);
        return;
      }
      try {
        const { path, changed } = runInstallClaude({ ...opts, cwd: process.cwd() });
        const verb = opts.uninstall ? 'removed from' : 'installed in';
        process.stdout.write(
          changed ? `keryx hooks ${verb} ${path}\n` : `${path}: nothing to change\n`,
        );
      } catch (error) {
        if (!(error instanceof InstallError)) throw error;
        process.stderr.write(`keryx: ${error.message}\n`);
        onResult(1);
      }
    });

  return program;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs the keryx CLI; resolves to the exit code once the command finished (`serve` resolves after startup). */
export async function runCli(argv: string[], hooks: CliHooks = {}): Promise<number> {
  let code = 0;
  const program = buildProgram((c) => {
    code = c;
  }, hooks);
  if (argv.length === 0) {
    process.stdout.write(program.helpInformation());
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return code;
}
