import { readFileSync } from 'node:fs';

export function readVersion(): string {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  return pkg.version;
}
