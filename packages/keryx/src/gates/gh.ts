import { execFile } from 'node:child_process';

/** `gh` is missing, not authenticated, or a call failed; the message is shown as is. */
export class GhError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhError';
  }
}

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `gh` with an argument array (never a shell string). Resolves for any exit code, so callers
 * can read the output of `gh pr checks`, which exits non-zero for failing and pending checks.
 */
export function gh(cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new GhError('gh is not installed; install the GitHub CLI (https://cli.github.com)'));
        return;
      }
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ exitCode: error ? (typeof code === 'number' ? code : 1) : 0, stdout, stderr });
    });
  });
}

/** Throws a GhError unless `gh` is installed and authenticated. */
export async function ensureGh(cwd: string): Promise<void> {
  const res = await gh(cwd, ['auth', 'status']);
  if (res.exitCode !== 0) {
    throw new GhError('gh is not authenticated; run `gh auth login`');
  }
}

/** Throws a GhError with the stderr of a failed call. */
export function requireOk(res: GhResult, what: string): string {
  if (res.exitCode !== 0) {
    throw new GhError(`${what} failed: ${res.stderr.trim() || `exit code ${res.exitCode}`}`);
  }
  return res.stdout;
}
