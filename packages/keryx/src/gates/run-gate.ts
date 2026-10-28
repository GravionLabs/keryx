import { spawn } from 'node:child_process';
import { readGateConfig } from './config.js';
import { dirtyPaths, resolveCommit, topLevel } from './git.js';

/** Characters of output kept per failing command. */
export const OUTPUT_TAIL_CHARS = 4000;
/** A command running longer than this is killed and counts as failed. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export interface CommandResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
}

export interface GateOutcome {
  commit: string;
  passed: boolean;
  /** Commands that ran, in order; the last one is the failing command when `passed` is false. */
  commands: CommandResult[];
  failedCommand?: string;
  outputTail?: string;
}

export type GateRun = { outcome: GateOutcome } | { refused: string };

interface Executed {
  exitCode: number | null;
  tail: string;
}

function execute(command: string, cwd: string, timeoutMs: number): Promise<Executed> {
  return new Promise((resolve) => {
    // Own process group (POSIX), so a timeout can kill the command's children too; a child
    // that outlives its shell would keep the output pipes open and the gate would hang.
    const grouped = process.platform !== 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (grouped && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // the group is already gone; fall through to the plain kill
        }
      }
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, tail: `${tail}${error.message}`.slice(-OUTPUT_TAIL_CHARS) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        tail: timedOut ? `${tail}\n[killed after ${timeoutMs} ms]`.slice(-OUTPUT_TAIL_CHARS) : tail,
      });
    });
  });
}

/**
 * Runs the `gate` commands of the worktree containing `cwd`, in order, stopping at the first
 * failure. Refuses (and runs nothing) without a `gate` key or with uncommitted changes, so the
 * result is always about exactly the commit HEAD.
 */
export async function runGate(
  cwd: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<GateRun> {
  const root = await topLevel(cwd);
  const config = await readGateConfig(root);
  if ('error' in config) {
    return { refused: config.error };
  }
  const dirty = await dirtyPaths(root);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).join('\n');
    const more = dirty.length > 10 ? `\n... and ${dirty.length - 10} more` : '';
    return {
      refused: `worktree has uncommitted changes; commit them first so the gate result belongs to a commit:\n${shown}${more}`,
    };
  }
  const commit = await resolveCommit(root);
  const commands: CommandResult[] = [];
  for (const command of config.commands) {
    const started = Date.now();
    const { exitCode, tail } = await execute(command, root, timeoutMs);
    commands.push({ command, exitCode, durationMs: Date.now() - started });
    if (exitCode !== 0) {
      return {
        outcome: { commit, passed: false, commands, failedCommand: command, outputTail: tail },
      };
    }
  }
  return { outcome: { commit, passed: true, commands } };
}
