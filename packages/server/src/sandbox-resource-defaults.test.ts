import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseByteSize, parseCpuCores, parseSwapSize } from './embedded.js';
import {
  DEFAULT_SANDBOX_MEMORY_BYTES,
  DEFAULT_SANDBOX_NANO_CPUS,
  DEFAULT_SANDBOX_SWAP_BYTES,
} from './provisioner.js';

const repoRoot = new URL('../../../', import.meta.url);

/** The `${NAME:-default}` fallback Compose ships for `name`. Read as text rather
 *  than parsed as YAML: `packages/server` declares no YAML parser, and the Server
 *  environment is one anchored block that every Server-shaped service inherits,
 *  so the name is assigned exactly once. */
function composeDefault(name: string): string | undefined {
  const compose = readFileSync(new URL('deploy/docker-compose.yml', repoRoot), 'utf8');
  const assignments = [
    ...compose.matchAll(new RegExp(`^\\s+${name}: \\$\\{${name}:-([^}]*)\\}$`, 'gm')),
  ];
  // A second assignment would make "the" default ambiguous; fail rather than pick one.
  expect(assignments).toHaveLength(1);
  return assignments[0]?.[1];
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
