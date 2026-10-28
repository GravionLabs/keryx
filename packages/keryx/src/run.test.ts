import { describe, expect, it } from 'vitest';
import { run } from './run.js';
import { readVersion } from './version.js';

function capture(args: string[]): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = run(args, (line) => lines.push(line));
  return { code, lines };
}

describe('run', () => {
  it('prints the package version for --version', () => {
    expect(capture(['--version'])).toEqual({ code: 0, lines: [readVersion()] });
  });

  it('prints usage without arguments', () => {
    expect(capture([])).toEqual({ code: 0, lines: ['Usage: keryx [--version]'] });
  });

  it('exits 1 on an unknown argument', () => {
    expect(capture(['bogus']).code).toBe(1);
  });
});

describe('readVersion', () => {
  it('returns a semver string', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
