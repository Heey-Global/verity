import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  checkStoreArchitecture,
  compareBaseline,
  compareImplementations,
  facadeImplementations,
  storeImportViolations,
} from './store-architecture-guard.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('checks the actual facade, migration debt and import graph', () => {
  expect(checkStoreArchitecture(process.cwd())).toEqual([]);
});

it('accepts parameter forwarding and detects logic hidden in a return expression', () => {
  expect(
    facadeImplementations('class EventStore { read(id: string) { return this.events.read(id); } }'),
  ).toEqual({});
  for (const body of [
    'return this.db.selectFrom("events");',
    'if (id) return this.events.read(id);',
    'return this.events.read(id.trim());',
  ]) {
    expect(
      Object.keys(facadeImplementations('class EventStore { read(id: string) { ' + body + ' } }')),
    ).toEqual(['read']);
  }
});

it('detects query closures in fields and top-level helpers', () => {
  const result = facadeImplementations(
    'function query() { return db.selectFrom("events"); } class EventStore { query = () => db.selectFrom("events"); }',
  );
  expect(Object.keys(result)).toEqual(['query', 'module: query']);
});

it('rejects changes to retained implementations and requires retired exceptions to disappear', () => {
  const old = facadeImplementations('class EventStore { read() { return 1; } }');
  const changed = facadeImplementations('class EventStore { read() { return 2; } }');
  expect(compareImplementations(changed, old)).toHaveLength(1);
  expect(compareImplementations({}, old)).toHaveLength(1);
  expect(compareBaseline(changed, old)).toHaveLength(1);
  expect(compareBaseline({ extra: 'hash' }, old)).toHaveLength(1);
  expect(compareBaseline({}, old)).toEqual([]);
});

it.each([
  "import type { EventStore } from './store.js';",
  "export * from './store.js';",
  "const target = './store.js'; import(target);",
  "import './index.js';",
])('rejects a store domain back-import through %s', (statement) => {
  const root = mkdtempSync(join(tmpdir(), 'store-imports-'));
  roots.push(root);
  const files = {
    'packages/server/tsconfig.json':
      '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}',
    'packages/server/src/entry.ts': 'export {};',
    'packages/store/tsconfig.json':
      '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}',
    'packages/store/package.json': '{"name":"@verity/store","type":"module"}',
    'packages/store/src/store.ts': 'export class EventStore {}',
    'packages/store/src/index.ts': "export * from './store.js';",
    'packages/store/src/domain.ts': statement,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  expect(
    storeImportViolations(root, Object.keys(files)).some((path) =>
      path.startsWith('packages/store/src/domain.ts -> '),
    ),
  ).toBe(true);
});
