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
  expect(
    facadeImplementations(
      'class EventStore { read(id: string) { return this\n.events.read(id); } }',
    ),
  ).toEqual({});
  for (const body of [
    'return this.db.selectFrom("events");',
    'if (id) return this.events.read(id);',
    'return this.events.read(id.trim());',
    'return this.events?.read(id);',
    'return this.events.read?.(id);',
    'return this?.events.read(id);',
  ]) {
    expect(
      Object.keys(facadeImplementations('class EventStore { read(id: string) { ' + body + ' } }')),
    ).toEqual(['read']);
  }
});

it.each(['appId, sessionId', 'sessionId', 'sessionId, sessionId'])(
  'rejects forwarding that changes the argument list to %s',
  (argumentsText) => {
    const source =
      'class EventStore { read(sessionId, appId) { return this.events.read(' +
      argumentsText +
      '); } }';
    expect(Object.keys(facadeImplementations(source))).toEqual(['read']);
  },
);

it('checks computed method names and rest forwarding', () => {
  expect(
    facadeImplementations('class EventStore { read(...ids) { return this.events.read(...ids); } }'),
  ).toEqual({});
  expect(
    Object.keys(
      facadeImplementations('class EventStore { read(...ids) { return this.events.read(ids); } }'),
    ),
  ).toEqual(['read']);
  expect(
    Object.keys(
      facadeImplementations(
        'class EventStore { [registerLookup()](id) { return this.events.read(id); } }',
      ),
    ),
  ).toEqual(['[registerLookup()]']);
});

it('checks decorators and computed names on fields without initializers', () => {
  const source =
    'class EventStore { @registerLookup accessor lookup!: Lookup; [registerField()]!: string; }';
  expect(Object.keys(facadeImplementations(source))).toEqual(['lookup', '[registerField()]']);
});

it.each([
  'class EventStore { [register()] = new EventSnapshotStore(() => this.db); }',
  'class EventStore { @register field = new EventSnapshotStore(() => this.db); }',
  '@register class EventStore {}',
  'class EventStore extends register() {}',
  'class EventStore extends BaseStore {}',
])('detects executable wiring in %s', (source) => {
  expect(Object.keys(facadeImplementations(source))).toHaveLength(1);
});

it('detects executable defaults in forwarding methods and fingerprints retained defaults', () => {
  const source = (value: string) =>
    'class EventStore { read(id = ' + value + ') { return this.events.read(id); } }';
  const original = facadeImplementations(source('this.db.selectFrom("events")'));
  expect(Object.keys(original)).toEqual(['read']);
  expect(compareImplementations(facadeImplementations(source('1')), original)).toHaveLength(1);
});

it('detects query closures in fields and top-level helpers', () => {
  const result = facadeImplementations(
    'function query() { return db.selectFrom("events"); } class EventStore { query = () => db.selectFrom("events"); }',
  );
  expect(Object.keys(result)).toEqual(['query', 'module: query']);
});

it('detects line breaks that change return semantics', () => {
  const original = facadeImplementations('class EventStore { read() { return 1; } }');
  const changed = facadeImplementations('class EventStore { read() { return\n1; } }');
  expect(compareImplementations(changed, original)).toHaveLength(1);
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
  "import './index.js'; import './store.js';",
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
  const targets = ['index', 'store'].filter((name) => statement.includes('./' + name + '.js'));
  expect(storeImportViolations(root, Object.keys(files))).toEqual(
    targets.map((name) => 'packages/store/src/domain.ts -> packages/store/src/' + name + '.ts'),
  );
});

it('requires removal of a retired constructor exception', () => {
  expect(compareImplementations({}, { constructor: 'previous fingerprint' })).toEqual([
    'Remove retired facade exception: constructor',
  ]);
});
