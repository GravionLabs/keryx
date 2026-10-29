import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InstallError, runInstallClaude } from './install.js';

let home: string;
let cwd: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'keryx-install-'));
  home = join(dir, 'home');
  cwd = join(dir, 'project');
  mkdirSync(cwd);
});

const userFile = () => join(home, '.claude', 'settings.json');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const seed = (path: string, json: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json));
};

const OTHER = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };

describe('runInstallClaude', () => {
  it('creates the user settings with all six hooks', () => {
    const result = runInstallClaude({ cwd, home });
    expect(result).toEqual({ path: userFile(), changed: true });
    expect(read(userFile()).hooks).toEqual({
      SessionStart: [{ hooks: [{ type: 'command', command: 'keryx hook SessionStart' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keryx hook UserPromptSubmit' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'keryx hook Stop' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'keryx hook Notification' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'keryx hook SubagentStop' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'keryx hook SessionEnd' }] }],
    });
  });

  it('is idempotent', () => {
    runInstallClaude({ cwd, home });
    const first = readFileSync(userFile(), 'utf8');
    expect(runInstallClaude({ cwd, home }).changed).toBe(false);
    expect(readFileSync(userFile(), 'utf8')).toBe(first);
  });

  it('writes the project file with --project', () => {
    const { path } = runInstallClaude({ cwd, home, project: true });
    expect(path).toBe(join(cwd, '.claude', 'settings.json'));
    expect(read(path).hooks.Stop).toHaveLength(1);
  });

  it('keeps other settings and hooks', () => {
    seed(userFile(), { model: 'x', hooks: { Stop: [OTHER], PreToolUse: [OTHER] } });
    runInstallClaude({ cwd, home });
    const settings = read(userFile());
    expect(settings.model).toBe('x');
    expect(settings.hooks.PreToolUse).toEqual([OTHER]);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]).toEqual(OTHER);
  });

  it('--uninstall removes only the keryx entries', () => {
    seed(userFile(), {
      model: 'x',
      hooks: {
        Stop: [OTHER, { hooks: [{ type: 'command', command: 'keryx hook Stop' }] }],
        SessionEnd: [
          {
            hooks: [
              { type: 'command', command: 'keryx hook SessionEnd' },
              { type: 'command', command: 'echo bye' },
            ],
          },
        ],
      },
    });
    expect(runInstallClaude({ cwd, home, uninstall: true }).changed).toBe(true);
    expect(read(userFile())).toEqual({
      model: 'x',
      hooks: {
        Stop: [OTHER],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
      },
    });
  });

  it('--uninstall after install leaves no hooks key', () => {
    seed(userFile(), { model: 'x' });
    runInstallClaude({ cwd, home });
    runInstallClaude({ cwd, home, uninstall: true });
    expect(read(userFile())).toEqual({ model: 'x' });
  });

  it('--uninstall without a settings file changes nothing', () => {
    expect(runInstallClaude({ cwd, home, uninstall: true }).changed).toBe(false);
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['hooks not an object', '{"hooks":[]}'],
    ['an event not an array', '{"hooks":{"Stop":{}}}'],
  ])('refuses settings that are %s and leaves the file alone', (_name, content) => {
    seed(userFile(), content);
    expect(() => runInstallClaude({ cwd, home })).toThrow(InstallError);
    expect(readFileSync(userFile(), 'utf8')).toBe(content);
  });
});
