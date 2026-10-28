import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db.js';
import { type GhStub, stubGh } from '../gates/gh-stub.test-util.js';
import { git, makeRepo } from '../gates/repo.test-util.js';
import { type RunningHttp, startHttp } from '../http.js';
import { createMcpServer } from './server.js';

let db: Db;
let http: RunningHttp;
let gh: GhStub;
const clients: Client[] = [];

beforeEach(async () => {
  gh = stubGh();
  db = openDb(':memory:');
  http = await startHttp({
    config: { host: '127.0.0.1', port: 0 },
    db,
    stateDir: mkdtempSync(join(tmpdir(), 'keryx-mcp-')),
  });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await http.close();
  db.close();
  gh.restore();
});

async function connect(cwd: string): Promise<Client> {
  const server = createMcpServer({ busUrl: http.url, cwd });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const types = () => db.listEventsSince(0).map((e) => e.type);
const eventOf = (type: string) => db.listEventsSince(0).find((e) => e.type === type);

/** A repo on a feature branch whose HEAD is gated and approved. */
async function gatedRepo(approve = true) {
  const dir = makeRepo(['true']);
  git(dir, 'switch', '-q', '-c', 'feat/20-x');
  const client = await connect(dir);
  await call(client, 'run_gate');
  if (approve) await call(client, 'record_review', { verdict: 'approve' });
  return { dir, client, commit: git(dir, 'rev-parse', 'HEAD') };
}

describe('open_pr', () => {
  it('creates the PR into the integration branch and records pr.opened', async () => {
    const { client, commit } = await gatedRepo();
    gh.reply('pr create', { stdout: 'https://github.com/o/r/pull/42\n' });
    const { isError, text } = await call(client, 'open_pr', { title: 'T', body: 'B', issue: 20 });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ pr: 42, branch: 'feat/20-x', base: 'release/next' });
    expect(gh.calls()).toContain(
      'pr create --base release/next --head feat/20-x --title T --body B',
    );
    expect(eventOf('pr.opened')).toMatchObject({
      issue: 20,
      data: { pr: 42, branch: 'feat/20-x', base: 'release/next', commit },
    });
  });

  it('refuses without a gate result and records pr.refused', async () => {
    const dir = makeRepo(['true']);
    const { isError, text } = await call(await connect(dir), 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain('no gate result');
    expect(eventOf('pr.refused')).toMatchObject({ data: { action: 'open_pr', reason: text } });
    expect(gh.calls().filter((c) => c.startsWith('pr create'))).toEqual([]);
  });

  it('refuses a failed gate', async () => {
    const dir = makeRepo(['false']);
    const client = await connect(dir);
    await call(client, 'run_gate');
    await call(client, 'record_review', { verdict: 'approve' });
    const { isError, text } = await call(client, 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain('gate failed');
    expect(types()).not.toContain('pr.opened');
  });

  it.each([
    ['no review', undefined, 'no review recorded'],
    ['a review asking for changes', 'changes', 'asks for changes'],
  ])('refuses with %s', async (_, verdict, message) => {
    const { client } = await gatedRepo(false);
    if (verdict) await call(client, 'record_review', { verdict });
    const { isError, text } = await call(client, 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain(message);
    expect(eventOf('pr.refused')).toBeDefined();
  });

  it('refuses when HEAD moved past the gated commit', async () => {
    const { dir, client } = await gatedRepo();
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'more');
    const { isError, text } = await call(client, 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain('no gate result');
  });

  it('fails clearly when gh is not authenticated and records no pr.opened', async () => {
    const { client } = await gatedRepo();
    gh.reply('auth status', { code: 1 });
    const { isError, text } = await call(client, 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain('gh auth login');
    expect(types()).not.toContain('pr.opened');
  });

  it('fails clearly when gh is missing', async () => {
    const { client } = await gatedRepo();
    // a PATH with git but without gh
    const bin = mkdtempSync(join(tmpdir(), 'keryx-nogh-'));
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    process.env.PATH = bin;
    const { isError, text } = await call(client, 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain('gh is not installed');
    expect(types()).not.toContain('pr.opened');
  });

  it('reports a failing gh pr create and records no pr.opened', async () => {
    const { client } = await gatedRepo();
    gh.reply('pr create', { code: 1, stderr: 'no commits between' });
    const { isError, text } = await call(client, 'open_pr', { title: 'T' });
    expect(isError).toBe(true);
    expect(text).toContain('no commits between');
    expect(types()).not.toContain('pr.opened');
  });
});

const view = (oid: string, state = 'OPEN') => JSON.stringify({ headRefOid: oid, state });
const checks = (...buckets: string[]) =>
  JSON.stringify(buckets.map((bucket, i) => ({ name: `check-${i}`, bucket })));

describe('merge', () => {
  it('merges when the required checks are green and records ci.finished and pr.merged', async () => {
    const { client, commit } = await gatedRepo();
    gh.reply('pr view', { stdout: view(commit) });
    gh.reply('pr checks', { stdout: checks('pass', 'skipping') });
    const { isError, text } = await call(client, 'merge', { pr: 42, issue: 20 });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ pr: 42, commit, merged: true });
    expect(gh.calls()).toContain('pr checks 42 --required --json name,bucket');
    expect(gh.calls()).toContain('pr merge 42 --squash');
    expect(eventOf('ci.finished')).toMatchObject({ issue: 20, data: { pr: 42, passed: true } });
    expect(eventOf('pr.merged')).toMatchObject({ issue: 20, data: { pr: 42, commit } });
    expect(types()).not.toContain('pr.refused');
  });

  it('refuses a failing check, records ci.finished passed=false and merges nothing', async () => {
    const { client, commit } = await gatedRepo();
    gh.reply('pr view', { stdout: view(commit) });
    gh.reply('pr checks', { stdout: checks('pass', 'fail'), code: 1 });
    const { isError, text } = await call(client, 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('check-1 (fail)');
    expect(eventOf('ci.finished')).toMatchObject({ data: { pr: 42, passed: false } });
    expect(eventOf('pr.refused')).toMatchObject({ data: { action: 'merge', pr: 42 } });
    expect(types()).not.toContain('pr.merged');
    expect(gh.calls().filter((c) => c.startsWith('pr merge'))).toEqual([]);
  });

  it('refuses pending checks without recording ci.finished', async () => {
    const { client, commit } = await gatedRepo();
    gh.reply('pr view', { stdout: view(commit) });
    gh.reply('pr checks', { stdout: checks('pass', 'pending'), code: 8 });
    const { isError, text } = await call(client, 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('still running');
    expect(types()).not.toContain('ci.finished');
    expect(types()).not.toContain('pr.merged');
  });

  it('refuses when gh reports no required checks', async () => {
    const { client, commit } = await gatedRepo();
    gh.reply('pr view', { stdout: view(commit) });
    gh.reply('pr checks', { stderr: 'no required checks reported', code: 1 });
    const { isError, text } = await call(client, 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('no required checks reported');
    expect(types()).not.toContain('pr.merged');
  });

  it('refuses when the PR head is not HEAD', async () => {
    const { client } = await gatedRepo();
    gh.reply('pr view', { stdout: view('f'.repeat(40)) });
    gh.reply('pr checks', { stdout: checks('pass') });
    const { isError, text } = await call(client, 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('is not the head of PR #42');
    expect(types()).not.toContain('pr.merged');
  });

  it('refuses a PR that is not open', async () => {
    const { client, commit } = await gatedRepo();
    gh.reply('pr view', { stdout: view(commit, 'MERGED') });
    const { isError, text } = await call(client, 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('MERGED');
  });

  it('refuses an ungated commit before calling gh', async () => {
    const dir = makeRepo(['true']);
    const { isError, text } = await call(await connect(dir), 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('no gate result');
    expect(gh.calls()).toEqual([]);
    expect(eventOf('pr.refused')).toMatchObject({ data: { action: 'merge', pr: 42 } });
  });

  it('fails clearly when gh is not authenticated and records nothing as passed', async () => {
    const { client } = await gatedRepo();
    gh.reply('auth status', { code: 1 });
    const { isError, text } = await call(client, 'merge', { pr: 42 });
    expect(isError).toBe(true);
    expect(text).toContain('gh auth login');
    expect(types()).not.toContain('ci.finished');
    expect(types()).not.toContain('pr.merged');
  });
});
