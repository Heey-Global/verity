import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Pin the transform cache under packages/mobile/.cache so CI can persist it
  // via actions/cache (mirrors the root config). .cache/ is gitignored.
  cacheDir: '.cache/vitest',
  resolve: {
    // Resolve the shared event contract to its TS source so the mobile tests run
    // without a prior `tsc -b` of @verity/events (mirrors the root config).
    alias: {
      '@verity/events': fileURLToPath(
        new URL('../../packages/events/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Only this package's source — @verity/events resolves to its own source
      // via the alias but lives outside `src/`, so it's gated by the root, not here.
      include: ['src/**/*.ts'],
      // Exclude test files, the re-export barrel (no logic), and the pure type
      // declarations in happy/message.ts (no executable code to measure).
      exclude: ['**/*.test.ts', 'src/index.ts', 'src/happy/message.ts'],
      // skipFull:false so the text summary lists every file (matches the root —
      // see chore: show fully-covered files). json-summary is the audit artifact.
      reporter: [['text', { skipFull: false }], 'json-summary', 'html'],
      // Same bar as the server packages (root vitest.config.ts).
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
