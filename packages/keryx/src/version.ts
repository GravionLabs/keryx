import { readFileSync } from 'node:fs';

/** Version of the installed keryx package (`package.json` next to `src/` or `dist/`); `null` when unreadable. */
export function keryxVersion(): string | null {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}
