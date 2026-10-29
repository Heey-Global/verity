import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLintProgram, lintFiles } from './lint-files.mjs';

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/lint-files-'));
  fixtures.push(root);
  const write = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  write('package.json', '{"type":"module"}');
  const config = write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', types: [] },
      include: ['src/**/*.ts'],
    }),
  );
  return { root, write, config };
}

it('omits unrelated modules while retaining unimported globals and augmentations', () => {
  const { write, config } = fixture();
  const target = write('src/target.ts', 'export const result = globalCount + augmentedCount;');
  const unrelated = write('src/unrelated.ts', 'export const unrelated = 1;');
  const globals = write('src/globals.d.ts', 'declare const globalCount: number;');
  const augmentation = write(
    'src/augmentation.ts',
    'export {}; declare global { const augmentedCount: number; }',
  );
  const program = createLintProgram(config, [target]);
  expect(program.getSourceFile(unrelated)).toBeUndefined();
  expect(program.getSourceFile(globals)).toBeDefined();
  expect(program.getSourceFile(augmentation)).toBeDefined();
  expect(
    program
      .getSemanticDiagnostics(program.getSourceFile(target))
      .map((diagnostic) => diagnostic.messageText),
  ).toEqual([]);
});

it('rejects requested files outside the configured project', () => {
  const { write, config } = fixture();
  write('src/included.ts', 'export {};');
  const outside = write('outside.ts', 'export {};');
  expect(() => createLintProgram(config, [outside])).toThrow('is not included');
});

it('uses current referenced sources for type-aware lint without build output or stale cache', async () => {
  const { root, write } = fixture();
  write(
    'dep/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        rootDir: 'src',
        outDir: 'dist',
        module: 'NodeNext',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );
  write('dep/src/index.ts', 'export const value = { label: "safe" };');
  write(
    'consumer/tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, composite: true, module: 'NodeNext', types: [] },
      references: [{ path: '../dep' }],
      include: ['src/**/*.ts'],
    }),
  );
  const consumer = write(
    'consumer/src/index.ts',
    'import { value } from "../../dep/dist/index.js";\nconst label: string = value.label;\nvoid label;',
  );
  const first = await lintFiles([consumer], root);
  expect(first.results).toHaveLength(1);
  expect(first.results.flatMap((result) => result.messages)).toEqual([]);
  write('dep/src/index.ts', 'export const value: any = { label: "unsafe" };');
  const second = await lintFiles([consumer], root);
  expect(
    second.results.flatMap((result) => result.messages.map((message) => message.ruleId)),
  ).toContain('@typescript-eslint/no-unsafe-assignment');
});
