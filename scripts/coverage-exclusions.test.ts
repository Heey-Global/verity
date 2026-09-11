import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { TYPE_ONLY_MODULES } from './coverage-exclusions.js';

// Every path excluded from coverage is a claim that there is nothing there to
// measure. The claim is true when it is written and silent when it stops being
// true: the file grows a function, the gate keeps reporting the same number, and
// the report the team reads to find gaps no longer lists the file at all. These
// tests re-derive each claim from the file it is about, so the exclusion has to
// keep earning itself.

/** Top-level statement kinds that emit no executable JavaScript. */
const DECLARATION_ONLY = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.EmptyStatement,
]);

/** Top-level statements in `file` that would run if the module were loaded. */
const executableStatements = (file: string): string[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  return source.statements
    .filter((statement) => !DECLARATION_ONLY.has(statement.kind))
    .map((statement) => ts.SyntaxKind[statement.kind]);
};

/** Every TypeScript source the coverage `include` glob picks up. */
const productSources = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join('packages', entry.name, 'src')))
    .flatMap((entry) => walk(join('packages', entry.name, 'src')));
};

describe('type-only coverage exclusions', () => {
  it('names files that exist', () => {
    // A renamed file leaves a stale entry that excludes nothing, and every
    // assertion below then passes by reading no file at all.
    expect(TYPE_ONLY_MODULES.filter((file) => !existsSync(file))).toEqual([]);
  });

  it.each(TYPE_ONLY_MODULES)('%s holds nothing executable', (file) => {
    // The moment one of these grows a function, excluding it stops being a
    // reporting fix and starts hiding an untested unit — with no other signal,
    // because a file outside `include` cannot lower a threshold.
    expect(executableStatements(file)).toEqual([]);
  });

  it('applies a check that a runtime module fails', () => {
    // Guards the guard. `preview-tunnel/src/index.ts` sits among the barrels,
    // is named like them, and holds a class and dozens of functions — it is the
    // exact file a `packages/*/src/index.ts` glob would have swallowed. If the
    // parse above ever degrades into something that passes for everything, it
    // passes for this too.
    expect(executableStatements('packages/preview-tunnel/src/index.ts')).not.toEqual([]);
    expect(TYPE_ONLY_MODULES).not.toContain('packages/preview-tunnel/src/index.ts');
  });
});

describe('CI-only harness coverage exclusions', () => {
  // Read out of the config rather than restated: these are the entries that
  // carry the gate, so a value copied to this test would keep it passing after
  // the config had moved on.
  const config = readFileSync('vitest.config.ts', 'utf8');
  const harnesses = [...config.matchAll(/^\s*'(?<path>packages\/\S*?)',$/gmu)]
    .map((match) => match.groups?.path ?? '')
    .filter((path) => /(live-smoke|canary)/u.test(path));

  it('finds the harness entries', () => {
    // Guards the guard: reformatted entries would make the checks below iterate
    // over nothing.
    expect(harnesses.length).toBeGreaterThanOrEqual(4);
    expect(harnesses.filter((file) => !existsSync(file))).toEqual([]);
  });

  it.each(harnesses)('%s exports nothing', (file) => {
    // The whole justification is that nothing in the product can reach these —
    // they are argv-dispatched scripts run out of `dist/`. An export is the
    // first step toward a product import, and the point where "test code the
    // gate should not count" quietly becomes "product code the gate no longer
    // counts".
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext);
    const exported = source.statements.filter(
      (statement) =>
        ts.isExportDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        (ts.canHaveModifiers(statement) &&
          ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)),
    );
    expect(exported.map((statement) => ts.SyntaxKind[statement.kind])).toEqual([]);
  });

  it('is imported by no product source', () => {
    // The other half of the same claim, checked from the calling side: an
    // excluded harness pulled into a measured module would carry its untested
    // branches into the product without ever appearing in the report.
    const specifiers = harnesses.map((file) =>
      file.replace(/^.*\/(?<name>[^/]+)\.ts$/u, '$<name>'),
    );
    const offenders = productSources()
      .filter((file) => !harnesses.includes(file))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return specifiers
          .filter((specifier) =>
            // Both forms, because they cost the same and hide equally well: a
            // named import via `from`, and a bare `import '…'` whose only effect
            // is to run the module — which for an argv-dispatched script is the
            // worse of the two.
            new RegExp(`(?:from|import)\\s+'[^']*${specifier}\\.js'`, 'u').test(source),
          )
          .map((specifier) => `${file} -> ${specifier}`);
      });
    expect(offenders).toEqual([]);
  });
});
