import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync('release-please-config.backend.json', 'utf8')) as {
  packages: Record<string, { 'exclude-paths'?: string[] }>;
};
const root = config.packages['.'];
// Release Please excludes directory prefixes, not minimatch globs or exact files.
// Read the shipped configuration so changing it changes these decisions.
const included = (files: string[]) =>
  files.some((file) => !root?.['exclude-paths']?.some((path) => file.startsWith(`${path}/`)));

describe('automatic backend release membership', () => {
  it('uses the root package and directory-prefix exclusions', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(root?.['exclude-paths']?.length).toBeGreaterThan(0);
    for (const path of root?.['exclude-paths'] ?? []) {
      expect(path).not.toMatch(/[?*]/);
      expect(path.endsWith('/')).toBe(false);
    }
  });

  // Synthetic paths exercise ownership without reading product/UI files.
  it.each([
    ['apps/mobile/release-routing-fixture.tsx'],
    ['packages/mobile/src/release-routing-fixture.ts'],
    ['docs/website/src/release-routing-fixture.tsx'],
    ['docs/release-routing-fixture.md'],
    ['.github/workflows/release-routing-fixture.yml'],
    ['.release/backend/intents/historical.md'],
  ])('keeps independent products and release infrastructure out: %j', (file) => {
    expect(included([file])).toBe(false);
  });

  it.each([
    ['packages/server/src/app.ts'],
    ['packages/session/src/supervisor.ts'],
    ['features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs'],
    ['deploy/docker-compose.yml'],
    ['package-lock.json', 'apps/mobile/release-routing-fixture.json'],
    ['packages/server/src/app.ts', 'docs/website/src/release-routing-fixture.tsx'],
  ])('retains product and shared build inputs: %j', (...files) => {
    expect(included(files)).toBe(true);
  });
});
