import { type Config, ConfigError } from './config.js';
import { openDb } from './db.js';
import { startHttp } from './http.js';
import { dbPath, stateDir } from './paths.js';

export interface RunningServe {
  url: string;
  close(): Promise<void>;
}

/** Opens the store and starts the bus HTTP server; resolves once it is listening. */
export async function serve(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): Promise<RunningServe> {
  const db = openDb(dbPath(env));
  let http: Awaited<ReturnType<typeof startHttp>>;
  try {
    http = await startHttp({ config, db, stateDir: stateDir(env) });
  } catch (error) {
    db.close();
    throw error;
  }
  process.stderr.write(`keryx listening on ${http.url}\n`);
  return {
    url: http.url,
    async close() {
      await http.close();
      db.close();
    },
  };
}

/** Prints a startup failure as one line; returns false for errors that are not expected. */
export function reportStartupError(
  error: unknown,
  config?: Pick<Config, 'host' | 'port'>,
): boolean {
  if (error instanceof ConfigError) {
    process.stderr.write(`keryx: ${error.message}\n`);
    return true;
  }
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
  if ((code === 'EADDRINUSE' || code === 'EACCES') && syscall === 'listen') {
    const where = config ? `${config.host}:${config.port}` : 'the configured address';
    const reason = code === 'EADDRINUSE' ? 'address already in use' : 'permission denied';
    process.stderr.write(`keryx: cannot listen on ${where}: ${reason}\n`);
    return true;
  }
  return false;
}
