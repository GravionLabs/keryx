import { execFile } from 'node:child_process';

/** Failure of a git call that the caller should show as is. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new GitError(`git ${args[0]} failed in ${cwd}: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Root of the worktree that contains `cwd`. */
export async function topLevel(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/** Full commit id of `ref` (default HEAD). */
export async function resolveCommit(cwd: string, ref = 'HEAD'): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Paths with uncommitted changes, untracked files included; empty for a clean worktree. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain']);
  return out.split('\n').filter((line) => line !== '');
}
