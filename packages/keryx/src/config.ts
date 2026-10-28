import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { configPath } from './paths.js';

type Env = Record<string, string | undefined>;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4778;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const ConfigFileSchema = z.strictObject({
  host: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

export interface Config {
  host: string;
  port: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readFile(path: string): z.infer<typeof ConfigFileSchema> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new ConfigError(`KERYX_PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

/** Config file, overridden by `KERYX_HOST`/`KERYX_PORT`, default `127.0.0.1:4778`. */
export function loadConfig(env: Env = process.env): Config {
  const file = readFile(configPath(env));
  const host = env.KERYX_HOST || file.host || DEFAULT_HOST;
  const port = env.KERYX_PORT ? parsePort(env.KERYX_PORT) : (file.port ?? DEFAULT_PORT);
  if (!LOOPBACK.has(host)) {
    throw new ConfigError(
      `host must be a loopback address (127.0.0.1, localhost, ::1), got "${host}"`,
    );
  }
  return { host, port };
}

/** Bus URL for clients: `KERYX_URL`, else the configured host and port. */
export function busUrl(env: Env = process.env): string {
  if (env.KERYX_URL) {
    return env.KERYX_URL.replace(/\/+$/, '');
  }
  const { host, port } = loadConfig(env);
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}
