import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { keryxVersion } from '../version.js';
import { runCli } from './program.js';

let dir: string;
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keryx-cli-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'config'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('KERYX_HOST', '127.0.0.1');
  vi.stubEnv('KERYX_PORT', '0');
  vi.stubEnv('KERYX_URL', '');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runCli', () => {
  it('prints the version', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['--version'])).toBe(0);
    expect(out).toHaveBeenCalledWith(`${keryxVersion()}\n`);
  });

  it('prints help without arguments', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli([])).toBe(0);
    expect(String(out.mock.calls[0]?.[0])).toContain('Usage: keryx');
  });

  it('exits non-zero for an unknown command', async () => {
    expect(await runCli(['bogus'])).not.toBe(0);
  });

  it('serves the bus and stores a posted event in the XDG state database', async () => {
    let url = '';
    expect(
      await runCli(['serve'], {
        onServe: (running) => {
          servers.push(running);
          url = running.url;
        },
      }),
    ).toBe(0);
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });

    expect(
      await runCli(['event', 'session.idle', '--issue', '4', '--data', '{"a":1}', '--url', url]),
    ).toBe(0);
    const body = (await (await fetch(`${url}/events`)).json()) as { events: unknown[] };
    expect(body.events).toMatchObject([
      { source: 'keryx-cli', type: 'session.idle', issue: 4, data: { a: 1 } },
    ]);
    // the database is where the XDG rule says
    await servers.pop()?.close();
    const db = openDb(join(dir, 'state', 'keryx', 'keryx.db'));
    expect(db.listEventsSince(0)).toHaveLength(1);
    db.close();
  });

  it('exits 0 with a notice when posting an event and keryx is not running', async () => {
    vi.stubEnv('KERYX_URL', 'http://127.0.0.1:1');
    expect(await runCli(['event', 'session.idle'])).toBe(0);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('bus not running at http://127.0.0.1:1'),
    );
  });

  it('reports an address already in use and exits 1', async () => {
    let port = '';
    await runCli(['serve'], {
      onServe: (running) => {
        servers.push(running);
        port = new URL(running.url).port;
      },
    });
    vi.stubEnv('KERYX_PORT', port);
    expect(await runCli(['serve'])).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('address already in use'),
    );
  });
});

describe('runCli hook and install', () => {
  it('keryx hook exits 0 silently when the bus is not running', async () => {
    vi.stubEnv('KERYX_URL', 'http://127.0.0.1:1');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['hook', 'Stop'])).toBe(0);
    expect(out).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('keryx install rejects an unknown harness', async () => {
    expect(await runCli(['install', 'vim'])).toBe(2);
  });
});
