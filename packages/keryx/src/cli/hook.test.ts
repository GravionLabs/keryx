import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, issueFromBranch, runHookCommand } from './hook.js';

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A fake ingest server; resolves its base URL and collects what was posted. */
async function fakeBus(): Promise<{ url: string; posted: Posted[] }> {
  const posted: Posted[] = [];
  const bus = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      posted.push({ url: req.url ?? '', body: JSON.parse(raw) });
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"ids":[1]}');
    });
  });
  server = bus;
  await new Promise<void>((r) => bus.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(bus.address() as AddressInfo).port}`, posted };
}

const stdin = (text: string) => async () => text;

const payload = (event: string) =>
  JSON.stringify({
    session_id: 'abc-123',
    cwd: '/work/keryx',
    hook_event_name: event,
    transcript_path: '/x',
  });

describe('runHookCommand', () => {
  it.each(Object.entries(HOOK_EVENTS))('maps %s to %s', async (event, type) => {
    const bus = await fakeBus();
    const code = await runHookCommand(event, stdin(payload(event)), () => bus.url, {
      env: { HERDR_PANE_ID: 'pane-7' },
      branch: async () => 'feat/6-claude-code-session-hooks',
    });
    expect(code).toBe(0);
    expect(bus.posted).toHaveLength(1);
    expect(bus.posted[0]?.url).toBe('/ingest');
    expect(bus.posted[0]?.body).toEqual({
      source: 'claude-code',
      type,
      agentId: 'abc-123',
      issue: 6,
      data: {
        sessionId: 'abc-123',
        cwd: '/work/keryx',
        branch: 'feat/6-claude-code-session-hooks',
        issue: 6,
        herdrPaneId: 'pane-7',
      },
    });
  });

  it('reports no issue and no pane for a plain branch', async () => {
    const bus = await fakeBus();
    await runHookCommand('Stop', stdin(payload('Stop')), () => bus.url, {
      env: {},
      branch: async () => 'main',
    });
    const body = bus.posted[0]?.body as { issue?: number; data: Record<string, unknown> };
    expect(body.issue).toBeUndefined();
    expect(body.data).toMatchObject({ branch: 'main', issue: null, herdrPaneId: null });
  });

  it('still reports an event with an empty payload', async () => {
    const bus = await fakeBus();
    await runHookCommand('SessionEnd', stdin(''), () => bus.url, { env: {} });
    expect(bus.posted[0]?.body).toMatchObject({
      type: 'session.ended',
      data: { sessionId: null, cwd: null, branch: null },
    });
  });

  it('posts nothing for an unknown event', async () => {
    const bus = await fakeBus();
    expect(await runHookCommand('PreToolUse', stdin(payload('x')), () => bus.url)).toBe(0);
    expect(bus.posted).toEqual([]);
  });

  it('exits 0 when keryx is not running', async () => {
    const started = Date.now();
    const code = await runHookCommand('Stop', stdin(payload('Stop')), () => 'http://127.0.0.1:1', {
      env: {},
      branch: async () => undefined,
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('exits 0 within the budget when the bus hangs', async () => {
    const hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const started = Date.now();
    try {
      const code = await runHookCommand(
        'Stop',
        stdin(payload('Stop')),
        () => `http://127.0.0.1:${(hang.address() as AddressInfo).port}`,
        { env: {}, branch: async () => undefined },
      );
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });

  it('exits 0 when the bus URL cannot be resolved', async () => {
    const code = await runHookCommand(
      'Stop',
      stdin(payload('Stop')),
      () => {
        throw new Error('bad config');
      },
      { env: {}, branch: async () => undefined },
    );
    expect(code).toBe(0);
  });
});

describe('issueFromBranch', () => {
  it.each([
    ['feat/6-claude-code-session-hooks', 6],
    ['fix/123-x', 123],
    ['chore/7-', 7],
  ])('%s -> %s', (branch, nr) => {
    expect(issueFromBranch(branch)).toBe(nr);
  });

  it.each([['main'], ['release/next'], ['feat/x-6'], ['feat/0-a'], [undefined]])(
    '%s -> none',
    (branch) => {
      expect(issueFromBranch(branch)).toBeUndefined();
    },
  );
});
