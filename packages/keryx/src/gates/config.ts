import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const GateSchema = z.array(z.string().trim().min(1)).min(1);

export type GateConfig = { commands: string[] } | { error: string };

/**
 * Reads the key `gate` (an array of shell commands) of `<root>/.agents/config.json`. The file
 * belongs to apm-hub; keryx reads only this key and ignores the rest.
 */
export async function readGateConfig(root: string): Promise<GateConfig> {
  const file = join(root, '.agents', 'config.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: `no gate configured: ${file} does not exist` };
    }
    return { error: `cannot read ${file}: ${(error as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: `${file} is not valid JSON` };
  }
  if (typeof json !== 'object' || json === null || !('gate' in json)) {
    return { error: `no gate configured: ${file} has no key "gate"` };
  }
  const parsed = GateSchema.safeParse((json as { gate: unknown }).gate);
  if (!parsed.success) {
    return { error: `${file}: "gate" must be a non-empty array of shell commands` };
  }
  return { commands: parsed.data };
}
