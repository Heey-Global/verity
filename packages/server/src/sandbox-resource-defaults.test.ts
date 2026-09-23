import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseByteSize, parseCpuCores, parseSwapSize } from './embedded.js';
import {
  DEFAULT_SANDBOX_MEMORY_BYTES,
  DEFAULT_SANDBOX_NANO_CPUS,
  DEFAULT_SANDBOX_SWAP_BYTES,
} from './provisioner.js';

const repoRoot = new URL('../../../', import.meta.url);

/** The `${NAME:-default}` fallback Compose ships for `name` on the Server. */
function composeDefault(name: string): string | undefined {
  const compose = parse(readFileSync(new URL('deploy/docker-compose.yml', repoRoot), 'utf8')) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  const interpolated = compose.services['verity']?.environment?.[name];
  return new RegExp(`^\\$\\{${name}:-([^}]*)\\}$`).exec(interpolated ?? '')?.[1];
}

describe('sandbox resource defaults', () => {
  // Compose sets these variables on every Compose Server; an embedded Server, or a
  // managed host whose sealed sources predate a variable, falls through to the
  // provisioner constant instead. If the two drift apart, some hosts get the old
  // ceilings with nothing wrong in any config file. Parsed with the Server's own
  // parsers, so a Compose default the Server would reject at boot also fails here.
  it.each([
    ['VERITY_SANDBOX_MEMORY', parseByteSize, DEFAULT_SANDBOX_MEMORY_BYTES],
    ['VERITY_SANDBOX_SWAP', parseSwapSize, DEFAULT_SANDBOX_SWAP_BYTES],
    ['VERITY_SANDBOX_CPUS', parseCpuCores, DEFAULT_SANDBOX_NANO_CPUS],
  ] as const)('ships the same %s from Compose as the provisioner', (name, parseValue, code) => {
    const shipped = composeDefault(name);
    expect(shipped).toBeDefined();
    expect(parseValue(shipped)).toBe(code);
    // Both defaults agreeing proves nothing if no code reads the name Compose sets:
    // an operator override would then do nothing while the deployment looks configured.
    expect(readFileSync(new URL('packages/server/src/server-main.ts', repoRoot), 'utf8')).toContain(
      `process.env.${name}`,
    );
  });
});
