import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGateConfig } from './config.js';

function root(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'keryx-gate-config-'));
  if (content !== undefined) {
    mkdirSync(join(dir, '.agents'));
    writeFileSync(join(dir, '.agents', 'config.json'), content);
  }
  return dir;
}

describe('readGateConfig', () => {
  it('reads the gate commands and ignores other keys', async () => {
    expect(await readGateConfig(root('{"format":false,"gate":["a","b"]}'))).toEqual({
      commands: ['a', 'b'],
    });
  });

  it.each([
    ['no file', undefined, /does not exist/],
    ['invalid JSON', '{', /not valid JSON/],
    ['no gate key', '{"x":1}', /no key "gate"/],
    ['a JSON array', '[]', /no key "gate"/],
    ['an empty gate', '{"gate":[]}', /non-empty array/],
    ['a string gate', '{"gate":"pnpm test"}', /non-empty array/],
    ['a blank command', '{"gate":["ok"," "]}', /non-empty array/],
  ])('refuses %s', async (_, content, message) => {
    const result = await readGateConfig(root(content));
    expect(result).toMatchObject({ error: expect.stringMatching(message) });
  });
});
