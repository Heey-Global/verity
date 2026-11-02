import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { lintFiles } from './lint-files.mjs';
import { LocalLintCache } from './lint-cache.mjs';

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/lint-cache-'));
  temporary.push(root);
  const write = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  write('package.json', '{"type":"module"}');
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', types: [] },
      include: ['src/**/*.ts'],
    }),
  );
  return { root, write };
}

it('reuses clean results, preserves hits after unrelated edits, and invalidates changed dependencies', async () => {
  const { root, write } = fixture();
  write('src/dep.ts', 'export const value = "safe";');
  const target = write(
    'src/target.ts',
    'import { value } from "./dep.js"; export const result: string = value;',
  );
  write('src/unrelated.ts', 'export const unused = 1;');
  const first = await lintFiles([target], root, { cache: true });
  expect(first.cached).toBe(false);
  expect(first.results.flatMap((result) => result.messages)).toEqual([]);
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(true);
  write('src/unrelated.ts', 'export const unused = 2;');
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(true);
  write('src/dep.ts', 'export const value: any = "unsafe";');
  const changed = await lintFiles([target], root, { cache: true });
  expect(changed.cached).toBe(false);
  expect(changed.results.flatMap((result) => result.messages.map((m) => m.ruleId))).toContain(
    '@typescript-eslint/no-unsafe-assignment',
  );
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(false);
});

it('invalidates unchanged consumers when a referenced source changes without rebuilding', async () => {
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
  write('dep/src/index.ts', 'export const value = "safe";');
  write(
    'consumer/tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, composite: true, module: 'NodeNext', types: [] },
      references: [{ path: '../dep' }],
      include: ['src/**/*.ts'],
    }),
  );
  const target = write(
    'consumer/src/index.ts',
    'import { value } from "../../dep/dist/index.js"; export const result: string = value;',
  );
  expect(
    (await lintFiles([target], root, { cache: true })).results.flatMap((result) => result.messages),
  ).toEqual([]);
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(true);
  write('dep/src/index.ts', 'export const value: any = "unsafe";');
  const changed = await lintFiles([target], root, { cache: true });
  expect(changed.cached).toBe(false);
  expect(changed.results.flatMap((result) => result.messages.map((m) => m.ruleId))).toContain(
    '@typescript-eslint/no-unsafe-assignment',
  );
});

it('refreshes global declarations, added project files and compiler configuration', async () => {
  const { root, write } = fixture();
  write('src/globals.d.ts', 'declare const globalValue: string;');
  const target = write('src/target.ts', 'export const value: string = globalValue;');
  await lintFiles([target], root, { cache: true });
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(true);
  write('src/new-global.d.ts', 'declare const anotherGlobal: string;');
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(false);
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(true);
  write('src/globals.d.ts', 'declare const globalValue: any;');
  const changed = await lintFiles([target], root, { cache: true });
  expect(changed.cached).toBe(false);
  expect(changed.results.flatMap((result) => result.messages.map((m) => m.ruleId))).toContain(
    '@typescript-eslint/no-unsafe-assignment',
  );
  write('tsconfig.json', JSON.stringify({ include: ['src/globals.d.ts'] }));
  await expect(lintFiles([target], root, { cache: true })).rejects.toThrow('is not included');
});

it('rechecks after missing imports appear and directory listings change', () => {
  const { root, write } = fixture();
  const target = write('src/target.ts', 'export const value = 1;');
  const missing = join(root, 'src/added.ts');
  const cache = new LocalLintCache([target], root, [], []);
  cache.readInput(target);
  const system = cache.observe({ ...ts.sys });
  expect(system.fileExists(missing)).toBe(false);
  system.readDirectory(join(root, 'src'), ['.ts'], undefined, ['**/*']);
  cache.save();
  expect(cache.hit()).toBe(true);
  write('src/added.ts', 'export const added = 1;');
  expect(cache.hit()).toBe(false);
});

it('invalidates changed lint configuration and corrupted cached data', async () => {
  const { root, write } = fixture();
  const target = write('src/target.ts', 'export const result = 1;');
  await lintFiles([target], root, { cache: true });
  const directory = join(root, '.cache/lint');
  for (const file of readdirSync(directory).filter((file) => file.endsWith('.json.gz'))) {
    writeFileSync(join(directory, file), 'invalid compressed data');
  }
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(false);
  expect((await lintFiles([target], root, { cache: true })).cached).toBe(true);
  const changed = new LocalLintCache([target], root, [{ rules: { 'no-undef': 'off' } }], []);
  expect(changed.hit()).toBe(false);
});
