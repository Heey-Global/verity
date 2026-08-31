// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // apps/mobile is the Expo/React-Native app — it gets its own RN-aware lint
    // setup in the Expo environment; the Node/TS root config doesn't apply.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'apps/mobile/**',
      '.verity-sessions/**',
      // Reproducible esbuild output; lint its typed sources instead.
      'features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test files may assert against loosely-typed fixtures. `*.test-helper.ts`
    // holds fixtures shared by several test files — same relaxations, but a name
    // the test runner does not collect as a suite of its own.
    files: ['**/*.test.ts', '**/*.test-helper.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Async generators that build an AsyncIterable from sync values (test
      // stream sources) legitimately have no `await` — a known false positive.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // `scripts/**` are Node maintenance tools run directly via `node`. Their
    // JSDoc-annotated `.mjs` helpers are type-checked HERE, via ESLint's
    // type-aware project service against scripts/tsconfig.json — NOT by the
    // `tsc -b` build (the root tsconfig references only the 5 packages, so the
    // build never traverses scripts/). They need the Node globals they use
    // declared since they're JS, not `.ts` (where those come from the ambient
    // `@types/node`). Declared inline (just the two used) to avoid a `globals`
    // package dependency.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        // Node 24's global fetch — prune-actions-cache.mjs talks to the GitHub
        // REST API with it rather than pulling in an HTTP dependency, and builds
        // its query strings with the matching WHATWG global.
        fetch: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    // `scripts/probes/**` reproduce security measurements against live agent
    // adapters (see the probe README). They consume untyped JSON-RPC from an
    // external process, so the `no-unsafe-*` rules fire on every message field
    // and would only be silenced by casts that assert more than the probe knows.
    // Lint them for real mistakes instead; correctness is established by running
    // them, not by the type-checker.
    files: ['scripts/probes/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // The sandbox toolkit ships this Node entrypoint directly rather than through
    // a package build. It is covered by a typed integration test in packages/server.
    files: ['features/**/*.{mjs,mts}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    // Config files (this file, root + per-workspace vitest.config.ts) live
    // outside any package tsconfig — lint them, but without type-aware rules
    // that need a project. `**/` so nested ones (apps/mobile) match too.
    files: ['**/*.js', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Real-Docker smoke harnesses execute directly with Node on the dedicated
    // workflow runner; they are syntax/lint checked but are not build inputs.
    files: ['deploy/bin/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);
