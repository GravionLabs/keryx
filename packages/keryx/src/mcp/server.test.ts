import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db.js';
import { git, makeRepo } from '../gates/repo.test-util.js';
import { type RunningHttp, startHttp } from '../http.js';
import { createMcpServer } from './server.js';

let db: Db;
let http: RunningHttp;
const clients: Client[] = [];

beforeEach(async () => {
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
});

async function connect(cwd: string, busUrl = http.url): Promise<Client> {
  const server = createMcpServer({ busUrl, cwd });
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
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text };
}

const events = () => db.listEventsSince(0);

describe('tools', () => {
  it('lists run_gate, record_review and gate_state', async () => {
    const client = await connect(makeRepo(['true']));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['gate_state', 'record_review', 'run_gate']);
  });
});

describe('run_gate', () => {
  it('runs the gate and records gate.finished with the commit', async () => {
    const dir = makeRepo(['echo ok']);
    const { isError, text } = await call(await connect(dir), 'run_gate');
    const commit = git(dir, 'rev-parse', 'HEAD');
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ commit, passed: true });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      source: 'keryx-mcp',
      type: 'gate.finished',
      data: { commit, passed: true, commands: [{ command: 'echo ok', exitCode: 0 }] },
    });
  });

  it('records the failing command and the tail of its output', async () => {
    const dir = makeRepo(['true', 'echo boom >&2; exit 2']);
    const { isError, text } = await call(await connect(dir), 'run_gate');
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toMatchObject({
      passed: false,
      failedCommand: 'echo boom >&2; exit 2',
      outputTail: expect.stringContaining('boom'),
    });
    expect(events()[0]?.data).toMatchObject({
      passed: false,
      failedCommand: 'echo boom >&2; exit 2',
      outputTail: expect.stringContaining('boom'),
    });
  });

  it('refuses a dirty worktree and records nothing', async () => {
    const dir = makeRepo(['true']);
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    const { isError, text } = await call(await connect(dir), 'run_gate');
    expect(isError).toBe(true);
    expect(text).toContain('uncommitted changes');
    expect(events()).toHaveLength(0);
  });

  it('refuses without a gate key and records nothing', async () => {
    const { isError, text } = await call(await connect(makeRepo()), 'run_gate');
    expect(isError).toBe(true);
    expect(text).toContain('no gate configured');
    expect(events()).toHaveLength(0);
  });
});

describe('record_review', () => {
  it('records review.recorded with commit, verdict and findings', async () => {
    const dir = makeRepo();
    const findings = [{ severity: 'important', file: 'a.ts', line: 3, summary: 'missing test' }];
    const { isError, text } = await call(await connect(dir), 'record_review', {
      verdict: 'changes',
      summary: 'one issue',
      findings,
    });
    const commit = git(dir, 'rev-parse', 'HEAD');
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ commit, verdict: 'changes', findings: 1 });
    expect(events()[0]).toMatchObject({
      type: 'review.recorded',
      data: { commit, verdict: 'changes', summary: 'one issue', findings },
    });
  });

  it('defaults findings to none', async () => {
    const dir = makeRepo();
    await call(await connect(dir), 'record_review', { verdict: 'approve' });
    expect(events()[0]?.data).toMatchObject({ verdict: 'approve', findings: [] });
  });

  it('rejects an unknown verdict and records nothing', async () => {
    const result = await call(await connect(makeRepo()), 'record_review', { verdict: 'maybe' });
    expect(result.isError).toBe(true);
    expect(events()).toHaveLength(0);
  });
});

describe('gate_state', () => {
  it('reports the last gate result and last review verdict for the commit', async () => {
    const dir = makeRepo(['true']);
    const client = await connect(dir);
    const commit = git(dir, 'rev-parse', 'HEAD');

    expect(JSON.parse((await call(client, 'gate_state')).text)).toEqual({
      commit,
      gate: null,
      review: null,
    });

    await call(client, 'run_gate');
    await call(client, 'record_review', { verdict: 'changes' });
    await call(client, 'record_review', { verdict: 'approve' });
    const state = JSON.parse((await call(client, 'gate_state')).text);
    expect(state.commit).toBe(commit);
    expect(state.gate).toMatchObject({ passed: true, failedCommand: null });
    expect(state.review).toMatchObject({ verdict: 'approve', findings: 0 });
  });

  it('keeps the results of other commits apart', async () => {
    const dir = makeRepo(['true']);
    const client = await connect(dir);
    const first = git(dir, 'rev-parse', 'HEAD');
    await call(client, 'run_gate');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = JSON.parse((await call(client, 'gate_state')).text);
    expect(second.gate).toBeNull();
    const old = JSON.parse((await call(client, 'gate_state', { commit: first })).text);
    expect(old.commit).toBe(first);
    expect(old.gate).toMatchObject({ passed: true });
  });

  it('errors for an unknown commit', async () => {
    const result = await call(await connect(makeRepo()), 'gate_state', { commit: 'deadbeef' });
    expect(result.isError).toBe(true);
  });
});

describe('keryx not running', () => {
  it.each([
    ['run_gate', {}],
    ['record_review', { verdict: 'approve' }],
    ['gate_state', {}],
  ])('%s fails with a message naming `keryx serve`', async (name, args) => {
    const dir = makeRepo(['touch ran.txt']);
    const client = await connect(dir, 'http://127.0.0.1:1');
    const { isError, text } = await call(client, name, args);
    expect(isError).toBe(true);
    expect(text).toContain('keryx serve');
    // run_gate must not run the gate when the result cannot be recorded
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
