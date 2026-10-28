import { readFileSync } from 'node:fs';
export function readVersion() {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8'));
  return pkg.version;
}
//# sourceMappingURL=version.js.map
