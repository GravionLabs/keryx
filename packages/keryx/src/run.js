import { readVersion } from './version.js';
export function run(args, out) {
  if (args.includes('--version') || args.includes('-v')) {
    out(readVersion());
    return 0;
  }
  out('Usage: keryx [--version]');
  return args.length === 0 ? 0 : 1;
}
//# sourceMappingURL=run.js.map
