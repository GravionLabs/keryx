import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueFromBranch, KeryxPlugin, type OpenCodeEvent } from './index.js';

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function fakeBus(): Promise<{ url: string; posted: Record<string, unknown>[] }> {
  const posted: Record<string, unknown>[] = [];
  const bus = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      posted.push(JSON.parse(raw));
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"ids":[1]}');
    });
  });
  server = bus;
  await new Promise<void>((r) => bus.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(bus.address() as AddressInfo).port}`, posted };
}

const branch = async () => 'feat/7-opencode-plugin';
const created = (id: string, parentID?: string): OpenCodeEvent => ({
  type: 'session.created',
  properties: { info: { id, directory: '/work/keryx', ...(parentID ? { parentID } : {}) } },
});

describe('KeryxPlugin', () => {
  it.each<[OpenCodeEvent, string]>([
    [created('ses_1'), 'session.started'],
    [
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      'session.working',
    ],
    [{ type: 'session.idle', properties: { sessionID: 'ses_1' } }, 'session.idle'],
    [{ type: 'permission.asked', properties: { sessionID: 'ses_1' } }, 'session.waiting'],
    [{ type: 'question.asked', properties: { sessionID: 'ses_1' } }, 'session.waiting'],
    [{ type: 'session.deleted', properties: { info: { id: 'ses_1' } } }, 'session.ended'],
  ])('maps %j to %s with the fields of the Claude Code hook', async (event, type) => {
    const bus = await fakeBus();
    const hooks = await KeryxPlugin(
      { directory: '/work/keryx' },
      { env: { KERYX_URL: bus.url, HERDR_PANE_ID: 'pane-7' }, branch },
    );
    await hooks.event?.({ event });
    expect(bus.posted).toEqual([
      {
        source: 'opencode',
        type,
        agentId: 'ses_1',
        issue: 7,
        data: {
          sessionId: 'ses_1',
          cwd: '/work/keryx',
          branch: 'feat/7-opencode-plugin',
          issue: 7,
          herdrPaneId: 'pane-7',
        },
      },
    ]);
  });

  it('reports a child session as subagent.finished and nothing else', async () => {
    const bus = await fakeBus();
    const hooks = await KeryxPlugin({ directory: '/w' }, { env: { KERYX_URL: bus.url }, branch });
    await hooks.event?.({ event: created('ses_child', 'ses_1') });
    await hooks.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_child', status: { type: 'busy' } },
      },
    });
    await hooks.event?.({
      event: { type: 'session.idle', properties: { sessionID: 'ses_child' } },
    });
    await hooks.event?.({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_child' } } },
    });
    expect(bus.posted.map((p) => p.type)).toEqual(['subagent.finished']);
  });

  it('ignores other events and a non-busy status', async () => {
    const bus = await fakeBus();
    const hooks = await KeryxPlugin({ directory: '/w' }, { env: { KERYX_URL: bus.url }, branch });
    await hooks.event?.({ event: { type: 'message.updated' } });
    await hooks.event?.({
      event: { type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } },
    });
    expect(bus.posted).toEqual([]);
  });

  it('works without input and reports no issue for a plain branch', async () => {
    const bus = await fakeBus();
    const hooks = await KeryxPlugin(undefined, {
      env: { KERYX_URL: bus.url },
      branch: async () => 'main',
    });
    await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    expect(bus.posted[0]).toMatchObject({ type: 'session.idle' });
    expect(bus.posted[0]).not.toHaveProperty('issue');
  });

  it('logs once and resolves when keryx is not running', async () => {
    const log = vi.fn();
    const hooks = await KeryxPlugin(
      { directory: '/w' },
      { env: { KERYX_URL: 'http://127.0.0.1:1' }, branch, log },
    );
    const started = Date.now();
    await hooks.event?.({ event: created('a') });
    await hooks.event?.({ event: created('b') });
    expect(log).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('resolves within the budget when the bus hangs', async () => {
    const hang = createServer(() => {});
    server = hang;
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const hooks = await KeryxPlugin(
      { directory: '/w' },
      {
        env: { KERYX_URL: `http://127.0.0.1:${(hang.address() as AddressInfo).port}` },
        branch,
        budgetMs: 100,
      },
    );
    const started = Date.now();
    await hooks.event?.({ event: created('a') });
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('logs through the OpenCode client by default and survives a failing client', async () => {
    const logFn = vi.fn(() => {
      throw new Error('client broken');
    });
    const hooks = await KeryxPlugin(
      { directory: '/w', client: { app: { log: logFn } } },
      { env: { KERYX_URL: 'http://127.0.0.1:1' }, branch },
    );
    await expect(hooks.event?.({ event: created('a') })).resolves.toBeUndefined();
    expect(logFn).toHaveBeenCalledWith({
      body: expect.objectContaining({ service: 'keryx', level: 'warn' }),
    });
  });

  it('uses KERYX_PORT when KERYX_URL is unset', async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request) => new Response('{}', { status: 202 }),
    );
    const hooks = await KeryxPlugin(
      { directory: '/w' },
      { env: { KERYX_PORT: '5000' }, branch, fetch: fetchFn as unknown as typeof fetch },
    );
    await hooks.event?.({ event: created('a') });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://127.0.0.1:5000/ingest');
  });
});

describe('issueFromBranch', () => {
  it('reads the issue from <type>/<nr>-<slug>', () => {
    expect(issueFromBranch('fix/123-x')).toBe(123);
    expect(issueFromBranch('main')).toBeUndefined();
    expect(issueFromBranch(undefined)).toBeUndefined();
  });
});
