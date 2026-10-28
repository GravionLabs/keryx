import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, makeRepo } from './repo.test-util.js';
import { OUTPUT_TAIL_CHARS, runGate } from './run-gate.js';

describe('runGate', () => {
  it('runs every command in order and passes for the HEAD commit', async () => {
    const dir = makeRepo(['echo one >> order.log', 'echo two >> order.log', 'cat order.log']);
    // order.log is created by the gate itself, so the tree is clean when it starts
    const run = await runGate(dir);
    expect(run).toMatchObject({
      outcome: { commit: git(dir, 'rev-parse', 'HEAD'), passed: true },
    });
    const outcome = 'outcome' in run ? run.outcome : undefined;
    expect(outcome?.commands.map((c) => [c.command, c.exitCode])).toEqual([
      ['echo one >> order.log', 0],
      ['echo two >> order.log', 0],
      ['cat order.log', 0],
    ]);
    expect(outcome?.failedCommand).toBeUndefined();
  });

  it('stops at the first failure and reports its command and output tail', async () => {
    const dir = makeRepo(['true', 'echo out-line; echo err-line >&2; exit 3', 'touch never-runs']);
    const run = await runGate(dir);
    const outcome = 'outcome' in run ? run.outcome : undefined;
    expect(outcome?.passed).toBe(false);
    expect(outcome?.failedCommand).toBe('echo out-line; echo err-line >&2; exit 3');
    expect(outcome?.outputTail).toContain('out-line');
    expect(outcome?.outputTail).toContain('err-line');
    expect(outcome?.commands.map((c) => c.exitCode)).toEqual([0, 3]);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('keeps only the tail of a long output', async () => {
    const dir = makeRepo(['i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done; exit 1']);
    const run = await runGate(dir);
    const tail = 'outcome' in run ? run.outcome.outputTail : '';
    expect(tail?.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
    expect(tail).toContain('line-2999');
    expect(tail).not.toContain('line-0\n');
  });

  it('runs the commands in the worktree root, also when called from a subdirectory', async () => {
    const dir = makeRepo(['test -f README.md']);
    expect(await runGate(join(dir, '.agents'))).toMatchObject({ outcome: { passed: true } });
  });

  it('fails a command that runs over the timeout', async () => {
    const dir = makeRepo(['sleep 5; true']);
    const run = await runGate(dir, 100);
    expect(run).toMatchObject({
      outcome: { passed: false, commands: [{ exitCode: null }] },
    });
    expect('outcome' in run && run.outcome.outputTail).toContain('killed after 100 ms');
  });

  it('refuses without a gate key and runs nothing', async () => {
    const dir = makeRepo();
    expect(await runGate(dir)).toMatchObject({
      refused: expect.stringContaining('no gate configured'),
    });
  });

  it.each([
    ['modified', (dir: string) => writeFileSync(join(dir, 'README.md'), 'changed\n')],
    ['untracked', (dir: string) => writeFileSync(join(dir, 'new.txt'), 'n\n')],
  ])('refuses with a %s file and runs nothing', async (_, dirty) => {
    const dir = makeRepo(['touch ran.txt']);
    dirty(dir);
    const run = await runGate(dir);
    expect(run).toMatchObject({ refused: expect.stringContaining('uncommitted changes') });
    expect(git(dir, 'status', '--porcelain')).not.toContain('ran.txt');
  });

  it('rejects when the directory is not a git repository', async () => {
    await expect(runGate('/')).rejects.toThrow(/git rev-parse failed/);
  });
});
