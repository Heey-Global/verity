import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { execFileSync, spawnSync } from 'node:child_process';
import { createLintProgram, lintFiles } from './lint-files.mjs';

const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

it('checks every batch and project while keeping ignored files out of the results', async () => {
  const { root, write } = fixture();
  const shared = write('src/shared.ts', 'export const value: any = "unsafe";');
  const unrelated = write('src/unrelated.ts', 'export const unrelated = 1;');
  const targets = Array.from({ length: 33 }, (_, index) =>
    write(
      `src/target-${index}.ts`,
      'import { value } from "./shared.js"; export const result: string = value;',
    ),
  );
  write(
    'other/tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', types: [] },
      include: ['*.ts'],
    }),
  );
  const other = write('other/target.ts', 'export const result: string = JSON.parse("null");');
  const untyped = write('config.js', 'missingFunction();');
  const ignored = write('dist/ignored.ts', 'this is not valid TypeScript');
  const reads = vi.spyOn(ts.sys, 'readFile');
  const { results } = await lintFiles([...targets, other, untyped, ignored], root);
  // Project discovery runs once; each bounded graph reads its imported sources afresh.
  expect(reads.mock.calls.filter(([file]) => file === unrelated)).toHaveLength(1);
  expect(reads.mock.calls.filter(([file]) => file === shared)).toHaveLength(4);
  expect(results.map((result) => result.filePath).sort()).toEqual(
    [...targets, other, untyped].sort(),
  );
  for (const target of [...targets, other]) {
    expect(
      results.find((result) => result.filePath === target)?.messages.map((m) => m.ruleId),
    ).toEqual(['@typescript-eslint/no-unsafe-assignment']);
  }
  expect(
    results.find((result) => result.filePath === untyped)?.messages.map((m) => m.ruleId),
  ).toEqual(['no-undef']);
});

it('refreshes global types and project includes between invocations', async () => {
  const { root, write } = fixture();
  const target = write('src/target.ts', 'export const result: string = globalValue;');
  write('src/globals.d.ts', 'declare const globalValue: string;');
  expect((await lintFiles([target], root)).results.flatMap((result) => result.messages)).toEqual(
    [],
  );
  write('src/globals.d.ts', 'declare const globalValue: any;');
  expect(
    (await lintFiles([target], root)).results.flatMap((result) =>
      result.messages.map((m) => m.ruleId),
    ),
  ).toContain('@typescript-eslint/no-unsafe-assignment');
  write('tsconfig.json', JSON.stringify({ include: ['src/globals.d.ts'] }));
  await expect(lintFiles([target], root)).rejects.toThrow('is not included');
});

it('covers current tracked and new files exactly once in bounded processes and stops on failure', () => {
  const { root, write } = fixture();
  const capture = join(root, 'arguments');
  write(
    'bin/node',
    String.raw`#!/bin/sh
printf '%s\0' "$@" >> "$LINT_CAPTURE"
printf '\0' >> "$LINT_CAPTURE"
exit "$LINT_EXIT"
`,
  );
  chmodSync(join(root, 'bin/node'), 0o755);
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    LINT_CAPTURE: capture,
    LINT_EXIT: '0',
  };
  execFileSync('bash', ['scripts/lint.sh'], { env });
  const batches = readFileSync(capture, 'utf8')
    .split('\0\0')
    .filter(Boolean)
    .map((line) => line.split('\0'));
  const files = batches.flatMap((args) => {
    expect(args.slice(0, 2)).toEqual(['scripts/lint-runner.mjs', '--']);
    expect(args.length - 2).toBeLessThanOrEqual(16);
    return args.slice(2);
  });
  const tracked = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file));
  expect(files).toHaveLength(tracked.length);
  expect(files.sort()).toEqual(tracked.sort());
  writeFileSync(capture, '');
  execFileSync('bash', ['scripts/lint.sh', '--no-cache'], { env });
  expect(
    readFileSync(capture, 'utf8')
      .split('\0\0')
      .filter(Boolean)
      .every(
        (batch) =>
          batch.split('\0').slice(0, 3).join(' ') === 'scripts/lint-runner.mjs --no-cache --',
      ),
  ).toBe(true);
  writeFileSync(capture, '');
  expect(spawnSync('bash', ['scripts/lint.sh'], { env: { ...env, LINT_EXIT: '7' } }).status).toBe(
    7,
  );
  expect(readFileSync(capture, 'utf8').split('\0\0').filter(Boolean)).toHaveLength(1);
});

it('retains Fastify request types without rooting the server runtime', () => {
  const config = resolve('packages/server/tsconfig.json');
  const target = resolve('packages/server/src/agent-gateway-url.ts');
  const program = createLintProgram(config, [target]);
  expect(program.getSourceFile(resolve('packages/server/src/server.ts')) !== undefined).toBe(false);
  expect(program.getSourceFile(resolve('packages/server/src/main.ts')) !== undefined).toBe(false);
  const augmentation = program.getSourceFile(
    resolve('packages/server/src/fastify-augmentation.ts'),
  )!;
  expect(augmentation).toBeDefined();
  expect(program.getSemanticDiagnostics(augmentation)).toEqual([]);
  const module = augmentation.statements.find(ts.isModuleDeclaration)!;
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(module.name)!;
  const request = checker
    .getExportsOfModule(symbol)
    .find((item) => item.name === 'FastifyRequest')!;
  const requestType = checker.getDeclaredTypeOfSymbol(request);
  const userId = requestType.getProperty('localUserId')!;
  expect(userId).toBeDefined();
  expect(checker.typeToString(checker.getTypeOfSymbolAtLocation(userId, augmentation))).toBe(
    'string | null',
  );
});
