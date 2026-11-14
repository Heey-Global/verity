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

it('omits documentation ASTs while preserving imported JavaScript JSDoc types', () => {
  const { write, config } = fixture();
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        allowJs: true,
        checkJs: true,
        module: 'NodeNext',
        types: [],
      },
      include: ['src/**/*'],
    }),
  );
  const dependency = write(
    'src/dependency.js',
    '/** @param {string} input */\nexport function value(input) { return input; }',
  );
  const target = write(
    'src/target.ts',
    'import { value } from "./dependency.js";\n/** Documentation link: {@link value}. */\nexport const result: number = value("typed");',
  );
  const program = createLintProgram(config, [target]);
  const source = program.getSourceFile(target)!;
  program.getTypeChecker();
  expect(ts.getJSDocCommentsAndTags(source.statements[1])).toHaveLength(0);
  expect(program.getSourceFile(dependency)).toBeDefined();
  expect(program.getSemanticDiagnostics(source).map(({ code }) => code)).toContain(2322);
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

it('finds the same problems with one shared program as with many small ones', async () => {
  // CI lints large groups in one type program. Sharing the program must not hide
  // or add findings, and it must actually be one program, not several.
  const { root, write } = fixture();
  const shared = write('src/shared.ts', 'export const value: any = "unsafe";');
  const targets = Array.from({ length: 40 }, (_, index) =>
    write(
      `src/target-${index}.ts`,
      index % 2
        ? 'import { value } from "./shared.js"; export const result: string = value;'
        : 'export const fine: string = "ok";',
    ),
  );
  const findings = (results: Awaited<ReturnType<typeof lintFiles>>['results']) =>
    Object.fromEntries(
      results.map((result) => [result.filePath, result.messages.map((m) => m.ruleId)]),
    );
  const reads = vi.spyOn(ts.sys, 'readFile');
  const small = await lintFiles(targets, root, { typeBatchSize: 1 });
  const smallReads = reads.mock.calls.filter(([file]) => file === shared).length;
  reads.mockClear();
  const large = await lintFiles(targets, root, { typeBatchSize: targets.length });
  // Project discovery reads every included file once; each program reads it again.
  expect(reads.mock.calls.filter(([file]) => file === shared)).toHaveLength(1 + 1);
  // Small programs load the shared module only for the targets that import it.
  expect(smallReads).toBe(1 + targets.filter((_, index) => index % 2).length);
  expect(findings(large.results)).toEqual(findings(small.results));
  expect(Object.values(findings(large.results)).flat()).toContain(
    '@typescript-eslint/no-unsafe-assignment',
  );
  reads.mockRestore();
  await expect(lintFiles(targets, root, { typeBatchSize: 0 })).rejects.toThrow('positive integer');
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

it('covers current tracked and new files exactly once per package and stops on failure', () => {
  const { root, write } = fixture();
  const capture = join(root, 'arguments');
  const guardCapture = join(root, 'guard');
  write(
    'bin/node',
    String.raw`#!/bin/sh
if [ "$1" = scripts/file-size-guard.mjs ]; then
  echo guard >> "$GUARD_CAPTURE"
  exit "$GUARD_EXIT"
fi
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
    GUARD_CAPTURE: guardCapture,
    GUARD_EXIT: '0',
  };
  execFileSync('bash', ['scripts/lint.sh'], { env });
  // The file-size check runs once over the whole tree, not per lint group.
  expect(readFileSync(guardCapture, 'utf8')).toBe('guard\n');
  const batches = readFileSync(capture, 'utf8')
    .split('\0\0')
    .filter(Boolean)
    .map((line) => line.split('\0'));
  // The runner bounds each worker group; lint.sh hands it one package at a time.
  const files = batches.flatMap((args) => {
    expect(args.slice(0, 2)).toEqual(['scripts/lint-runner.mjs', '--']);
    return args.slice(2);
  });
  const packages = new Set(
    files.filter((file) => file.startsWith('packages/')).map((file) => file.split('/')[1]),
  );
  expect(batches.length).toBe(packages.size + 1);
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
  // A file-size failure stops the run before any lint group starts.
  writeFileSync(capture, '');
  expect(spawnSync('bash', ['scripts/lint.sh'], { env: { ...env, GUARD_EXIT: '1' } }).status).toBe(
    1,
  );
  expect(readFileSync(capture, 'utf8')).toBe('');
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

it('uses only validated classification metadata while rechecking unchanged consumers', async () => {
  const { root, write } = fixture();
  const target = write('src/target.ts', 'export const result: string = globalValue;');
  write('src/global.ts', 'export const ignored = 1;');
  write('src/initial.d.ts', 'declare const globalValue: string;');
  const check = () => lintFiles([target], root, { cache: false });
  expect((await check()).results.flatMap((r) => r.messages)).toEqual([]);
  expect((await check()).results.map((r) => r.filePath)).toEqual([target]);
  write('src/initial.d.ts', 'export {};');
  write('src/global.ts', 'declare const globalValue: any;');
  expect((await check()).results.flatMap((r) => r.messages.map((m) => m.ruleId))).toContain(
    '@typescript-eslint/no-unsafe-assignment',
  );
  write('src/global.ts', 'export {};');
  write('src/new.d.ts', 'declare const globalValue: any;');
  expect((await check()).results.flatMap((r) => r.messages.map((m) => m.ruleId))).toContain(
    '@typescript-eslint/no-unsafe-assignment',
  );
  write('tsconfig.json', JSON.stringify({ include: ['src/new.d.ts'] }));
  await expect(check()).rejects.toThrow('is not included');
});

it('bypasses both caches with --no-cache and still checks every typed input in CI', () => {
  const { root, write } = fixture();
  const target = write('src/target.ts', 'export const result: string = globalValue;');
  write('src/global.d.ts', 'declare const globalValue: string;');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve('scripts/lint-runner.mjs'), ...args, '--', target], {
      cwd: root,
      env: { ...process.env, CI: 'true' },
      encoding: 'utf8',
    });
  expect(run(['--no-cache']).status).toBe(0);
  expect(existsSync(join(root, '.cache/lint-ambient'))).toBe(false);
  expect(run([]).status).toBe(0);
  expect(existsSync(join(root, '.cache/lint-ambient'))).toBe(true);
  write('src/global.d.ts', 'declare const globalValue: any;');
  const changed = run([]);
  expect(changed.status).toBe(1);
  expect(changed.stdout).toContain('@typescript-eslint/no-unsafe-assignment');
  expect(changed.stdout).not.toContain('Reused clean lint results');
});

it('retains unimported library and type references that change global lint types', async () => {
  const { root, write, config } = fixture();
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'NodeNext',
        types: [],
      },
      include: ['src/**/*'],
    }),
  );
  const target = write(
    'src/target.mjs',
    '/** @param {Response} response\n * @returns {Promise<unknown>} */\nexport async function read(response) { return await response.json(); }',
  );
  const library = write('src/library.ts', '/// <reference lib="dom" />\nexport {};');
  const types = write('src/types.ts', '/// <reference types="../extra/global.d.ts" />\nexport {};');
  write('extra/global.d.ts', 'declare const extraGlobal: number;');
  const pathReference = write(
    'src/path.ts',
    '/// <reference path="../extra/path.d.ts" />\nexport {};',
  );
  write('extra/path.d.ts', 'declare const pathGlobal: number;');
  const program = createLintProgram(config, [target]);
  expect(program.getSourceFile(library)).toBeDefined();
  expect(program.getSourceFile(types)).toBeDefined();
  expect(program.getSourceFile(pathReference)).toBeDefined();
  expect(program.getSourceFile(resolve(root, 'extra/global.d.ts'))).toBeDefined();
  expect(program.getSourceFile(resolve(root, 'extra/path.d.ts'))).toBeDefined();
  expect(program.getSourceFiles().some((source) => source.fileName.endsWith('/lib.dom.d.ts'))).toBe(
    true,
  );
  const { ESLint } = await import('eslint');
  const canonical = await new ESLint({ cwd: root }).lintFiles([target]);
  const { results } = await lintFiles([target], root, { ambientCache: false });
  expect(results.flatMap((result) => result.messages)).toEqual(
    canonical.flatMap((result) => result.messages),
  );
  expect(results.flatMap((result) => result.messages.map((message) => message.ruleId))).toContain(
    '@typescript-eslint/no-unsafe-return',
  );
});

it('reports diagnostic phases without changing typed lint findings', async () => {
  const { root, write } = fixture();
  write(
    'packages/server/tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', types: [] },
      include: ['src/**/*.ts'],
    }),
  );
  const target = write(
    'packages/server/src/server.ts',
    'export function read(input: any) { return input.missing; }',
  );
  const baseline = await lintFiles([target], root);
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('VERITY_LINT_PROFILE', '1');
  try {
    const profiled = await lintFiles([target], root);
    expect(profiled.results.map((result) => result.messages)).toEqual(
      baseline.results.map((result) => result.messages),
    );
    expect(profiled.results[0]?.errorCount).toBeGreaterThan(0);
    expect(
      output.mock.calls.map(
        ([line]) => (JSON.parse(String(line)) as { lintProfile: string }).lintProfile,
      ),
    ).toEqual([
      'program-start',
      'program-ready',
      'eslint-start',
      'rules-start',
      'rules-exit',
      'eslint-complete',
    ]);
    output.mockClear();
    vi.stubEnv('LINT_MEASUREMENT_DIR', root);
    const retained = await lintFiles([target], root);
    expect(retained.results.map((result) => result.messages)).toEqual(
      baseline.results.map((result) => result.messages),
    );
    expect(output).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'phases.ndjson'), 'utf8')).toContain(
      '"lintProfile":"rules-start"',
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
