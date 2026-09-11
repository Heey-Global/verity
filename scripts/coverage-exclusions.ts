/**
 * Coverage exclusions that a test has to keep honest, kept out of
 * `vitest.config.ts` so the test can read them without importing it.
 *
 * That is not tidiness. `vitest.config.ts` imports `vitest/config`, which pulls
 * the DOM lib into whatever program resolves it, and the DOM lib types
 * `Response.json()` as `any` where `undici-types` says `unknown`. A test under
 * `scripts/` that imported the config therefore turned `await response.json()`
 * into an `any` in two unrelated `.mjs` scripts and failed
 * `@typescript-eslint/no-unsafe-assignment` in files it never touched.
 */

/**
 * Modules that transpile to nothing executable: `import`, `export type`,
 * `interface`, and re-export lines only. V8 instruments every file in the
 * coverage `include` glob whether a test loads it or not, and the text reporter
 * renders their 0/0 as `0%` — which reads, in the one report the team uses to
 * find gaps, exactly like a wholly untested product module. Removing that
 * misreading is the ONLY thing this list does: every entry contributes zero
 * statements, lines, branches and functions, so no threshold moves by a digit
 * either way.
 *
 * The risk a list like this carries runs the other direction — a file named here
 * later grows a function and is then never measured again, with the report
 * staying green over it. `coverage-exclusions.test.ts` parses each entry and
 * fails if any top-level statement is anything but an import, a re-export, or a
 * type declaration. `packages/preview-tunnel/src/index.ts` is why that guard
 * exists and why this list is written out rather than globbed over every
 * package's `src/index.ts`: it is named like the barrels around it and holds a
 * class and dozens of functions.
 */
export const TYPE_ONLY_MODULES = [
  'packages/adapter-claude/src/index.ts',
  'packages/adapter-claude/src/permission.ts',
  'packages/events/src/index.ts',
  'packages/secret-contracts/src/index.ts',
  'packages/server/src/index.ts',
  'packages/session/src/index.ts',
  'packages/session/src/runner-transcript-sink.ts',
  'packages/store/src/index.ts',
  'packages/store/src/schema.ts',
];
