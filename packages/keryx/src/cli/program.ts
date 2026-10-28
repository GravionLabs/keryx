import { Command, CommanderError } from 'commander';
import { busUrl, ConfigError, loadConfig } from '../config.js';
import { type RunningServe, reportStartupError, serve } from '../serve.js';
import { keryxVersion } from '../version.js';
import { runEventCommand } from './event.js';

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

  return program;
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
