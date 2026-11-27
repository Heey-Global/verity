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

it('allows the Workspace store to resolve the current Google account store', () => {
  const source = (accounts: string) =>
    'class EventStore { workspace = new GoogleWorkspaceStore(() => this.db, ' + accounts + '); }';
  expect(facadeImplementations(source('() => this.googleAccounts'))).toEqual({});
  expect(Object.keys(facadeImplementations(source('() => this.googleAccounts.get(id)')))).toEqual([
    'workspace',
  ]);
});

it('allows the project repository store to forward project lookup', () => {
  const source = (lookup: string) =>
    'class EventStore { repositories = new ProjectRepositoryStore(() => this.db, ' +
    lookup +
    '); }';
  expect(facadeImplementations(source('(id) => this.getProject(id)'))).toEqual({});
  for (const lookup of [
    '(id) => this.getProject(otherId)',
    '(id) => this.deleteProject(id)',
    '(id) => this.getProject?.(id)',
    '(id = defaultId) => this.getProject(id)',
  ]) {
    expect(Object.keys(facadeImplementations(source(lookup)))).toEqual(['repositories']);
  }
});

it('allows the event history store to forward backward page reads in order', () => {
  const source = (read: string) =>
    'class EventStore { history = new EventHistoryStore(() => this.db, ' + read + '); }';
  expect(
    facadeImplementations(
      source('(id, limit, before) => this.getEventsBeforeSeq(id, limit, before)'),
    ),
  ).toEqual({});
  expect(
    Object.keys(
      facadeImplementations(
        source('(id, limit, before) => this.getEventsBeforeSeq(id, before, limit)'),
      ),
    ),
  ).toEqual(['history']);
});

it('allows the event history store to forward full-log reads without overriding the cursor', () => {
  const source = (read: string) =>
    'class EventStore { history = new EventHistoryStore(() => this.db, ' +
    '(id, limit, before) => this.getEventsBeforeSeq(id, limit, before), ' +
    read +
    '); }';
  expect(facadeImplementations(source('(id, after) => this.getEventsAfter(id, after)'))).toEqual(
    {},
  );
  expect(
    Object.keys(facadeImplementations(source('(id, after) => this.getEventsAfter(id, 0)'))),
  ).toEqual(['history']);
});

it('allows Google connections to forward their session and project lookups', () => {
  const source = (contacts: string) => `
    class EventStore {
      connections = new GoogleConnectionStore(
        () => this.db,
        () => this.googleAccounts,
        (id) => this.getSession(id),
        (id, service) => this.getProjectGoogleConnection(id, service),
        (id, user) => this.getSessionGmailConnection(id, user),
        (id, user) => this.getSessionCalendarConnection(id, user),
        ${contacts},
      );
    }
  `;
  expect(
    facadeImplementations(source('(id, user) => this.getSessionContactsConnection(id, user)')),
  ).toEqual({});
  expect(
    Object.keys(
      facadeImplementations(source('(id, user) => this.getSessionContactsConnection(user, id)')),
    ),
  ).toEqual(['connections']);
});

it('requires the turn record store to pass the session and prompt sequence in order', () => {
  const source = (args: string) => `
    class EventStore {
      turns = new TurnRecordStore(
        () => this.db,
        (id) => this.isSessionDeleting(id),
        () => this.listRunningTurns(),
        (id, seq) => this.promptInitiatorAt(${args}),
      );
    }
  `;
  expect(facadeImplementations(source('id, seq'))).toEqual({});
  expect(Object.keys(facadeImplementations(source('seq, id')))).toEqual(['turns']);
});

it('allows the project lifecycle store to forward reads and receive the change feed', () => {
  const source = (feed: string) => `
    class EventStore {
      lifecycle = new ProjectLifecycleStore(
        () => this.db,
        (id) => this.getProject(id),
        ${feed},
        () => this.listProjects(),
        (owner, repo, connection) => this.listProjectsByOwnerRepo(owner, repo, connection),
      );
    }
  `;
  expect(facadeImplementations(source('this.projectChanges'))).toEqual({});
  expect(Object.keys(facadeImplementations(source('this.otherFeed')))).toEqual(['lifecycle']);
});

it('allows plan implementation to use the existing append and projection stores', () => {
  const source = (store: string, projection: string) =>
    'class EventStore { plan = new ' +
    store +
    '(() => this.db, () => this.cipher, () => this.eventWrites, ' +
    projection +
    '); }';
  expect(
    facadeImplementations(source('PlanImplementationStore', '() => this.messageProjection')),
  ).toEqual({});
  expect(
    Object.keys(facadeImplementations(source('OtherStore', '() => this.messageProjection'))),
  ).toEqual(['plan']);
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

it('detects generator methods that defer the call until iteration', () => {
  const source = 'class EventStore { *read(id) { return this.events.read(id); } }';
  expect(Object.keys(facadeImplementations(source))).toEqual(['read']);
});

it('detects queries through the raw database handle', () => {
  expect(
    Object.keys(
      facadeImplementations(
        'class EventStore { query(table) { return this.rootDb.selectFrom(table); } }',
      ),
    ),
  ).toEqual(['query']);
});
