import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GhReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface GhStub {
  /** Sets the reply for `gh <a> <b>`, for example `reply('pr checks', {...})`. */
  reply(subcommand: string, reply: GhReply): void;
  /** Argument lines of every call, in order. */
  calls(): string[];
  restore(): void;
}

const SCRIPT = `#!/bin/sh
d="$GH_STUB_DIR"
printf '%s\\n' "$*" >> "$d/calls.log"
key="$1-$2"
[ -f "$d/$key.out" ] && cat "$d/$key.out"
[ -f "$d/$key.err" ] && cat "$d/$key.err" >&2
[ -f "$d/$key.code" ] && exit "$(cat "$d/$key.code")"
exit 0
`;

/** Puts a fake \`gh\` first on PATH; unconfigured subcommands print nothing and exit 0. */
export function stubGh(): GhStub {
  const dir = mkdtempSync(join(tmpdir(), 'keryx-gh-'));
  const bin = join(dir, 'gh');
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  const oldDir = process.env.GH_STUB_DIR;
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.GH_STUB_DIR = dir;
  return {
    reply(subcommand, { stdout, stderr, code }) {
      const key = subcommand.replace(' ', '-');
      if (stdout !== undefined) writeFileSync(join(dir, `${key}.out`), stdout);
      if (stderr !== undefined) writeFileSync(join(dir, `${key}.err`), stderr);
      if (code !== undefined) writeFileSync(join(dir, `${key}.code`), String(code));
    },
    calls() {
      const file = join(dir, 'calls.log');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    },
    restore() {
      process.env.PATH = oldPath;
      if (oldDir === undefined) delete process.env.GH_STUB_DIR;
      else process.env.GH_STUB_DIR = oldDir;
    },
  };
}
