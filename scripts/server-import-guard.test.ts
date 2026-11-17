import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkServerImports, serverImportViolations } from './server-import-guard.mjs';

const roots: string[] = [];
const prefix = 'packages/server/src/';
function fixture(files: Record<string, string>, paths = {}, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'imports-'));
  roots.push(root);
  const contents = {
    'packages/server/tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rootDir: 'src',
        outDir: 'dist',
        paths,
      },
      include: ['src/**/*.ts'],
    }),
    'packages/server/package.json': JSON.stringify({
      name: '@verity/server',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
    [`${prefix}server.ts`]: 'export const server = 1;',
    ...extra,
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [prefix + path, text])),
  };
  for (const [path, text] of Object.entries(contents)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return serverImportViolations(root, Object.keys(contents));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('server composition-root imports', () => {
  it('checks the actual source tree', () => {
    expect(() => checkServerImports(process.cwd())).not.toThrow();
  });
  it.each([
    "import { server } from './server.js';",
    "export { server } from './server.js';",
    "export * from './server.js';",
    "import type { server } from './server.js';",
    "type Server = typeof import('./server.js');",
    "import('./server.js');",
    'import(`./server.js`);',
    "require('./server.js');",
    "import server = require('./server.js');",
    "const path = './server.js'; import(path);",
    "import('./' + 'server.js');",
    "import('./server.js' as string);",
    "const stem = 'server'; import(`./${stem}.js`);",
  ])('rejects %s', (text) => {
    expect(fixture({ 'domain.ts': text })).toEqual([`${prefix}domain.ts -> ${prefix}server.ts`]);
  });
  it('follows multiple barrels through an allowed public entry point', () => {
    const found = fixture({
      'domain.ts': "import './barrel.js';",
      'barrel.ts': "export * from './index.js';",
      'index.ts': "export * from './server.js';",
    });
    expect(found).toContain(
      `${prefix}domain.ts -> ${prefix}barrel.ts -> ${prefix}index.ts -> ${prefix}server.ts`,
    );
  });
  it('resolves tsconfig path aliases', () => {
    expect(
      fixture({ 'domain.ts': "import '#root';" }, { '#root': ['./src/server.ts'] }),
    ).toHaveLength(1);
  });
  it('resolves workspace exports to source without built output', () => {
    expect(
      fixture({
        'domain.ts': "import '@verity/server';",
        'index.ts': "export * from './server.js';",
      }),
    ).toEqual([`${prefix}domain.ts -> ${prefix}index.ts -> ${prefix}server.ts`]);
  });
  it('follows a barrel outside the server workspace', () => {
    expect(
      fixture(
        { 'domain.ts': "import '../../events/src/bridge.js';" },
        {},
        {
          'packages/events/src/bridge.ts': "export * from '../../server/src/server.js';",
        },
      ),
    ).toContain(`${prefix}domain.ts -> packages/events/src/bridge.ts -> ${prefix}server.ts`);
  });
  it('follows declaration barrels', () => {
    expect(
      fixture({
        'domain.ts': "import type { server } from './barrel.js';",
        'barrel.d.ts': "export * from './server.js';",
      }),
    ).toHaveLength(2);
  });
  it('does not loop on barrel cycles', () => {
    expect(
      fixture({
        'a.ts': "import './b.js';",
        'b.ts': "import './a.js'; export * from './server.js';",
      }),
    ).toHaveLength(2);
  });
  it('allows outer entry points and test consumers', () => {
    expect(
      fixture(
        Object.fromEntries(
          [
            'app.ts',
            'embedded.ts',
            'server-main.ts',
            'main.ts',
            'index.ts',
            'testing.ts',
            'domain.test.ts',
            'server-fixture.test-helper.ts',
          ].map((file) => [file, "import './server.js';"]),
        ),
      ),
    ).toEqual([]);
  });
  it('does not exempt production consumers of test helpers', () => {
    expect(
      fixture({
        'domain.ts': "import './server-fixture.test-helper.js';",
        'server-fixture.test-helper.ts': "import './server.js';",
      }),
    ).toHaveLength(1);
  });
  it('resolves constant imports in their lexical scope', () => {
    expect(
      fixture({
        'domain.ts':
          "function first() { const path = './server.js'; return import(path); } function second() { const path = './other.js'; return import(path); }",
      }),
    ).toHaveLength(1);
  });
  it('does not treat a runtime parameter as an outer constant', () => {
    expect(
      fixture({
        'domain.ts': "const path = './server.js'; function load(path) { return import(path); }",
      }),
    ).toEqual([]);
  });
  it.each([
    'for (const path of paths) {}',
    'for (const path in paths) {}',
    "for (let path = './other.js'; condition;) {}",
    'try {} catch (path) {}',
    "switch (value) { case 1: const path = './other.js'; break; }",
  ])('keeps the outer constant visible after %s', (statement) => {
    expect(
      fixture({ 'domain.ts': `const path = './server.js'; ${statement} import(path);` }),
    ).toHaveLength(1);
  });
  it.each([
    'function load({ path }) { return import(path); }',
    'const load = function path() { return import(path); };',
    'const load = class path { load() { return import(path); } };',
    'function load([path]) { return import(path); }',
    '{ const { path } = runtime; import(path); }',
    '{ const { nested: { path } } = runtime; import(path); }',
    '{ const [path] = runtime; import(path); }',
  ])('treats destructured shadows as runtime values: %s', (statement) => {
    expect(fixture({ 'domain.ts': `const path = './server.js'; ${statement}` })).toEqual([]);
  });
  it('ignores comments, ordinary strings and unresolved runtime expressions', () => {
    expect(
      fixture({
        'domain.ts': "// import './server.js';\nconst text = './server.js'; import(runtimePath);",
      }),
    ).toEqual([]);
  });
});
