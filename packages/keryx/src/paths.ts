import { homedir } from 'node:os';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** `$VAR` when set and absolute, else `fallback` below the home directory (XDG Base Directory rule). */
function xdgDir(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value?.startsWith('/') ? value : join(env.HOME ?? homedir(), fallback);
}

/** `${XDG_CONFIG_HOME:-~/.config}/keryx/config.json` */
export function configPath(env: Env = process.env): string {
  return join(xdgDir(env, 'XDG_CONFIG_HOME', '.config'), 'keryx', 'config.json');
}

/** `${XDG_STATE_HOME:-~/.local/state}/keryx`: runtime state, never inside a project. */
export function stateDir(env: Env = process.env): string {
  return join(xdgDir(env, 'XDG_STATE_HOME', '.local/state'), 'keryx');
}

export function dbPath(env: Env = process.env): string {
  return join(stateDir(env), 'keryx.db');
}
