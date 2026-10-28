import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { busUrl, ConfigError, loadConfig } from './config.js';

function envWithConfig(content?: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'keryx-config-'));
  if (content !== undefined) {
    mkdirSync(join(dir, 'keryx'));
    writeFileSync(join(dir, 'keryx', 'config.json'), content);
  }
  return { XDG_CONFIG_HOME: dir, HOME: dir };
}

describe('loadConfig', () => {
  it('defaults to 127.0.0.1:4778 without a file', () => {
    expect(loadConfig(envWithConfig())).toEqual({ host: '127.0.0.1', port: 4778 });
  });

  it('reads host and port from the config file', () => {
    const env = envWithConfig('{"host":"localhost","port":5000}');
    expect(loadConfig(env)).toEqual({ host: 'localhost', port: 5000 });
  });

  it('lets KERYX_HOST and KERYX_PORT override the file', () => {
    const env = { ...envWithConfig('{"port":5000}'), KERYX_HOST: '::1', KERYX_PORT: '6000' };
    expect(loadConfig(env)).toEqual({ host: '::1', port: 6000 });
  });

  it('rejects a non-loopback host', () => {
    expect(() => loadConfig({ ...envWithConfig(), KERYX_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...envWithConfig(), KERYX_PORT: '99999' })).toThrow(/KERYX_PORT/);
    expect(() => loadConfig({ ...envWithConfig(), KERYX_PORT: 'abc' })).toThrow(/KERYX_PORT/);
  });

  it('rejects invalid JSON and unknown keys in the file', () => {
    expect(() => loadConfig(envWithConfig('{'))).toThrow(/not valid JSON/);
    expect(() => loadConfig(envWithConfig('{"hots":"x"}'))).toThrow(ConfigError);
  });
});

describe('busUrl', () => {
  it('prefers KERYX_URL and trims trailing slashes', () => {
    expect(busUrl({ ...envWithConfig(), KERYX_URL: 'http://127.0.0.1:9/' })).toBe(
      'http://127.0.0.1:9',
    );
  });

  it('falls back to host and port from the config', () => {
    expect(busUrl(envWithConfig('{"port":5001}'))).toBe('http://127.0.0.1:5001');
    expect(busUrl({ ...envWithConfig(), KERYX_HOST: '::1' })).toBe('http://[::1]:4778');
  });
});
