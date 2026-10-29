import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from './db.js';
import { type GhStub, stubGh } from './gates/gh-stub.test-util.js';
import { type RunningHttp, startHttp } from './http.js';

const HEAD = 'a'.repeat(40);
const MERGE = { type: 'merge', pr: 7, repo: 'o/r' };
const view = (head = HEAD, state = 'OPEN') => ({
  stdout: JSON.stringify({ headRefOid: head, state }),
});
const checks = (...buckets: string[]) => ({
  stdout: JSON.stringify(buckets.map((bucket, i) => ({ name: `c${i}`, bucket }))),
});

let db: Db;
let http: RunningHttp;
let gh: GhStub;

beforeEach(async () => {
  gh = stubGh();
  db = openDb(':memory:');
  http = await startHttp({
    config: { host: '127.0.0.1', port: 0 },
    db,
    stateDir: mkdtempSync(join(tmpdir(), 'keryx-approvals-')),
    approvals: { retryMs: 10, maxWaitMs: 200 },
  });
});

afterEach(async () => {
  await http.close();
  db.close();
  gh.restore();
});

async function createApproval(action: Record<string, unknown> | undefined = MERGE) {
  const res = await fetch(`${http.url}/attention`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'APPROVAL',
      issue: 21,
      summary: 'merge the release PR',
      options: ['approve', 'reject'],
      ...(action ? { action } : {}),
    }),
  });
  return ((await res.json()) as { id: number }).id;
}

const answer = (id: number, text: string) =>
  fetch(`${http.url}/attention/${id}/answer`, {
    method: 'POST',
    body: JSON.stringify({ text, by: 'tester' }),
  });

const types = () => db.queryEvents({ limit: 100 }).events.map((e) => e.type);
const merges = () => gh.calls().filter((c) => c.startsWith('pr merge'));

/** Negative cases: nothing is expected to happen, so give a wrongly started merge time to show. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

describe('approved merge attentions', () => {
  it('merges the PR once approved with green checks, records pr.merged and acks', async () => {
    gh.reply('pr view', view());
    gh.reply('pr checks', checks('pass', 'skipping'));
    const id = await createApproval();
    expect(types()).toContain('approval.armed');
    await answer(id, 'approve');
    await expect.poll(() => db.getAttention(id)?.state).toBe('acked');
    expect(merges()).toEqual([`pr merge 7 --repo o/r --squash --match-head-commit ${HEAD}`]);
    expect(types()).toContain('pr.merged');
    expect(types()).not.toContain('approval.failed');
  });

  it('reject records the answer and does nothing else', async () => {
    gh.reply('pr view', view());
    const id = await createApproval();
    await answer(id, 'reject');
    await settled();
    expect(db.getAttention(id)?.state).toBe('answered');
    expect(merges()).toEqual([]);
    expect(types()).not.toContain('pr.merged');
    expect(types()).not.toContain('approval.failed');
  });

  it('refuses red checks with approval.failed and leaves the attention unacked', async () => {
    gh.reply('pr view', view());
    gh.reply('pr checks', checks('pass', 'fail'));
    const id = await createApproval();
    await answer(id, 'approve');
    await expect.poll(types).toContain('approval.failed');
    const failed = db.queryEvents({ types: ['approval.failed'], limit: 10 }).events[0];
    expect(failed?.data.reason).toContain('c1 (fail)');
    expect(merges()).toEqual([]);
    expect(db.getAttention(id)?.state).toBe('answered');
  });

  it('refuses when the head changed since the attention was created', async () => {
    gh.reply('pr view', view());
    gh.reply('pr checks', checks('pass'));
    const id = await createApproval();
    gh.reply('pr view', view('b'.repeat(40)));
    await answer(id, 'approve');
    await expect.poll(types).toContain('approval.failed');
    const failed = db.queryEvents({ types: ['approval.failed'], limit: 10 }).events[0];
    expect(failed?.data.reason).toContain('changed');
    expect(merges()).toEqual([]);
  });

  it('retries pending checks until they are green', async () => {
    gh.reply('pr view', view());
    gh.reply('pr checks', checks('pending'));
    const id = await createApproval();
    await answer(id, 'approve');
    await expect
      .poll(() => gh.calls().filter((c) => c.startsWith('pr checks')).length)
      .toBeGreaterThan(1);
    gh.reply('pr checks', checks('pass'));
    await expect.poll(() => db.getAttention(id)?.state).toBe('acked');
    expect(merges()).toHaveLength(1);
  });

  it('gives up on checks that stay pending', async () => {
    gh.reply('pr view', view());
    gh.reply('pr checks', checks('pending'));
    const id = await createApproval();
    await answer(id, 'approve');
    await expect.poll(types, { timeout: 2000 }).toContain('approval.failed');
    const failed = db.queryEvents({ types: ['approval.failed'], limit: 10 }).events[0];
    expect(failed?.data.reason).toContain('still running');
    expect(merges()).toEqual([]);
    expect(db.getAttention(id)?.state).toBe('answered');
  });

  it('fails without merging when gh is not authenticated', async () => {
    gh.reply('pr view', view());
    gh.reply('pr checks', checks('pass'));
    const id = await createApproval();
    gh.reply('auth status', { code: 1 });
    await answer(id, 'approve');
    await expect.poll(types).toContain('approval.failed');
    const failed = db.queryEvents({ types: ['approval.failed'], limit: 10 }).events[0];
    expect(failed?.data.reason).toContain('not authenticated');
    expect(merges()).toEqual([]);
  });

  it('fails when no head was pinned at creation', async () => {
    gh.reply('auth status', { code: 1 });
    const id = await createApproval();
    gh.reply('auth status', { code: 0 });
    gh.reply('pr checks', checks('pass'));
    gh.reply('pr view', view());
    expect(types()).not.toContain('approval.armed');
    await answer(id, 'approve');
    await expect.poll(types).toContain('approval.failed');
    expect(merges()).toEqual([]);
  });

  it('stores and ignores actions of another type', async () => {
    const id = await createApproval({ type: 'notify', pr: 7, repo: 'o/r' });
    await answer(id, 'approve');
    await settled();
    expect(gh.calls()).toEqual([]);
    expect(db.getAttention(id)?.state).toBe('answered');
  });

  it('does not let a producer forge approval events', async () => {
    const res = await fetch(`${http.url}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ source: 'x', type: 'approval.armed', data: {} }),
    });
    expect(res.status).toBe(403);
  });
});
