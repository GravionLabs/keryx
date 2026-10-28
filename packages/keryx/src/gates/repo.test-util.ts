import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A temp git repository with one commit; `gate` is written to .agents/config.json when given. */
export function makeRepo(gate?: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'keryx-repo-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  if (gate !== undefined) {
    mkdirSync(join(dir, '.agents'));
    writeFileSync(join(dir, '.agents', 'config.json'), JSON.stringify({ gate }));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
