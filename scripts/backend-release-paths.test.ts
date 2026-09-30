import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
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
  it('keeps actual mobile test fixtures out of the backend release', () => {
    // A mobile-only fixture outside the app makes its entire commit a server release.
    const fixtures: string[] = [];
    for (const test of globSync('apps/mobile/**/*.test.{ts,tsx}')) {
      const source = readFileSync(test, 'utf8');
      for (const match of source.matchAll(
        /resolve\(__dirname,\s*['"]([^'"]*fixtures[^'"]*)['"]/g,
      )) {
        const fixture = relative(process.cwd(), resolve(dirname(test), match[1]));
        expect(readFileSync(fixture).length).toBeGreaterThan(0);
        fixtures.push(fixture);
      }
    }
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) expect(included([fixture]), fixture).toBe(false);
  });

  it('excludes the historical mobile fixture path when rebuilding release history', () => {
    // Moving a file does not remove its old pathname from an already merged commit.
    expect(included(['scripts/fixtures/mobile/Expo57AppDelegate.swift'])).toBe(false);
  });

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
