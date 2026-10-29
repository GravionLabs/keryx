import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOOK_EVENTS } from './hook.js';

const COMMAND_PREFIX = 'keryx hook ';

export interface InstallOptions {
  /** Write `.claude/settings.json` of `cwd` instead of the user file. */
  project?: boolean;
  uninstall?: boolean;
  cwd: string;
  home?: string;
}

interface HookEntry {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export function settingsPath(opts: InstallOptions): string {
  return opts.project
    ? join(opts.cwd, '.claude', 'settings.json')
    : join(opts.home ?? homedir(), '.claude', 'settings.json');
}

function isKeryx(entry: unknown): boolean {
  const command = (entry as HookEntry | null)?.command;
  return typeof command === 'string' && command.startsWith(COMMAND_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSettings(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new InstallError(`cannot read ${path}: ${(error as Error).message}`);
  }
  if (raw.trim() === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new InstallError(`${path} is not valid JSON; fix it by hand first`);
  }
  if (!isRecord(json)) throw new InstallError(`${path} must contain a JSON object`);
  return json;
}

/** Installs or removes (`uninstall`) the keryx hooks; resolves to the settings file it wrote. */
export function runInstallClaude(opts: InstallOptions): { path: string; changed: boolean } {
  const path = settingsPath(opts);
  const settings = readSettings(path);
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!isRecord(hooks)) throw new InstallError(`${path}: "hooks" must be an object`);
  const before = JSON.stringify(settings);

  for (const event of Object.keys(HOOK_EVENTS)) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new InstallError(`${path}: hooks.${event} must be an array`);
    }
    const groups = (current ?? []) as HookGroup[];
    if (opts.uninstall) {
      const kept = groups
        .map((group) =>
          Array.isArray(group.hooks)
            ? { ...group, hooks: group.hooks.filter((entry) => !isKeryx(entry)) }
            : group,
        )
        .filter(
          (group, i) =>
            !Array.isArray(group.hooks) || group.hooks.length > 0 || !hasKeryx(groups[i]),
        );
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    } else if (!groups.some(hasKeryx)) {
      hooks[event] = [
        ...groups,
        { hooks: [{ type: 'command', command: `${COMMAND_PREFIX}${event}` }] },
      ];
    }
  }

  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  if (JSON.stringify(settings) === before) return { path, changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path, changed: true };
}

function hasKeryx(group: HookGroup | undefined): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(isKeryx);
}
