import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { serializeSqliteInitialization } = require('../apps/mobile/sqlite-web-transformer.cjs') as {
  serializeSqliteInitialization: (src: string, filename: string) => string;
};
const filename = require
  .resolve('expo-sqlite/package.json')
  .replace('package.json', 'web/worker.ts');
const original = readFileSync(filename, 'utf8');

function fixture(source: string) {
  const start = source.includes('let initialization:')
    ? source.indexOf('let initialization:')
    : source.indexOf('async function maybeInitAsync');
  const end = source.indexOf('//#endregion Internal helpers', start);
  const compiled = ts.transpile(source.slice(start, end), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  });
  let release!: () => void;
  const persistent = new Promise<object>((resolve) => {
    release = () => resolve({});
  });
  const initialize = runInNewContext(
    `
    let _sqlite3 = null, _vfs = null, _vfsMemory = null;
    const wasmModule = '', VFS_NAME_PERSISTENT = 'persistent', VFS_NAME_MEMORY = 'memory';
    const WaSQLiteFactory = async () => ({});
    const SQLite = { Factory: () => ({ vfs_register() {} }) };
    const MemoryVFS = { create: async () => ({}) };
    ${compiled}
    maybeInitAsync;
  `,
    { AccessHandlePoolVFS: { create: () => persistent } },
  ) as () => Promise<unknown>;
  return { initialize, release };
}

it('reproduces Invalid VFS state from the installed worker during concurrent initialization', async () => {
  const { initialize, release } = fixture(original);
  const first = initialize();
  await Promise.resolve();
  await Promise.resolve();
  await expect(initialize()).rejects.toThrow('Invalid VFS state');
  release();
  await first;
});

it('waits for persistent VFS initialization when another database opens concurrently', async () => {
  const { initialize, release } = fixture(serializeSqliteInitialization(original, filename));
  const first = initialize();
  await Promise.resolve();
  await Promise.resolve();
  const second = initialize();
  release();
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(await first).toBe(await second);
});

it('fails closed when the dependency no longer matches the guarded initializer', () => {
  expect(() => serializeSqliteInitialization('changed upstream source', filename)).toThrow(
    'reassess',
  );
});
