import { PGlite } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type MigrationLockOptions,
  type QueryCompiler,
  type QueryResult,
} from 'kysely';

import type { Database } from './schema.js';

/**
 * Minimal Kysely dialect over pglite — real Postgres compiled to WASM, running
 * in-process. TEST-ONLY: it lets the suite run hermetically with no Postgres
 * service (see `./testing.ts`). The production runtime uses a real PostgreSQL via
 * {@link createPostgresDb} (the server requires `DATABASE_URL`); pglite has been
 * removed from the runtime. It reuses Kysely's stock Postgres adapter/compiler/
 * introspector; only the driver is bespoke.
 *
 * `@electric-sql/pglite` is a devDependency, so this module is reachable only
 * through the `@verity/store/testing` entry point — never from the package
 * index. Keep it that way: a production import would resolve fine in the
 * monorepo and fail in the `npm ci --omit=dev` runtime image.
 */
class PgliteTransactionCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly releases = new WeakMap<DatabaseConnection, () => void>();
  private owner: DatabaseConnection | undefined;
  private ownerMigration: MigrationScope | undefined;

  async execute<R>(
    connection: DatabaseConnection,
    query: () => Promise<QueryResult<R>>,
  ): Promise<QueryResult<R>> {
    const migration = migrationScope.getStore();
    if (
      this.owner === connection ||
      (migration?.active === true && migration === this.ownerMigration)
    ) {
      return await query();
    }
    const release = await this.lock();
    try {
      return await query();
    } finally {
      release();
    }
  }

  async acquire(connection: DatabaseConnection): Promise<void> {
    const release = await this.lock();
    this.releases.set(connection, release);
    this.owner = connection;
    this.ownerMigration = migrationScope.getStore();
  }

  release(connection: DatabaseConnection): void {
    const release = this.releases.get(connection);
    this.releases.delete(connection);
    if (this.owner === connection) {
      this.owner = undefined;
      this.ownerMigration = undefined;
    }
    release?.();
  }

  private async lock(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => done);
    await previous;
    return release;
  }
}

class PgliteConnection implements DatabaseConnection {
  constructor(
    private readonly client: PGlite,
    private readonly coordinator: PgliteTransactionCoordinator,
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return await this.coordinator.execute(this, async () => {
      const result = await this.client.query<R>(compiledQuery.sql, [...compiledQuery.parameters]);
      return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) };
    });
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error('the pglite dialect does not support streaming');
  }
}

export class PgliteDriver implements Driver {
  private readonly transactions = new PgliteTransactionCoordinator();

  constructor(private readonly client: PGlite) {}

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(new PgliteConnection(this.client, this.transactions));
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await this.transactions.acquire(connection);
    try {
      await connection.executeQuery(CompiledQuery.raw('begin'));
    } catch (error) {
      this.transactions.release(connection);
      throw error;
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await connection.executeQuery(CompiledQuery.raw('commit'));
    } finally {
      this.transactions.release(connection);
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await connection.executeQuery(CompiledQuery.raw('rollback'));
    } finally {
      this.transactions.release(connection);
    }
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  async destroy(): Promise<void> {
    await this.client.close();
  }
}

interface MigrationScope {
  active: boolean;
}

const migrationScope = new AsyncLocalStorage<MigrationScope>();

class PgliteAdapter extends PostgresAdapter {
  override async acquireMigrationLock(
    db: Kysely<unknown>,
    options: MigrationLockOptions,
  ): Promise<void> {
    // PGlite has one physical session, so the transaction coordinator is the
    // migration lock. Mark this async branch as deliberately re-entrant: Kysely
    // asks the migration provider to read the ledger through the root `db`
    // while its migration transaction is open. Only descendants of this branch
    // may share that transaction; unrelated queries still wait for commit.
    migrationScope.enterWith({ active: true });
    await super.acquireMigrationLock(db, options);
  }

  override async releaseMigrationLock(
    db: Kysely<unknown>,
    options: MigrationLockOptions,
  ): Promise<void> {
    try {
      await super.releaseMigrationLock(db, options);
    } finally {
      const scope = migrationScope.getStore();
      if (scope) scope.active = false;
    }
  }
}

class PgliteDialect implements Dialect {
  constructor(private readonly client: PGlite) {}

  createAdapter(): DialectAdapter {
    return new PgliteAdapter();
  }

  createDriver(): Driver {
    return new PgliteDriver(this.client);
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
}

/**
 * TEST-ONLY: a pglite-backed Kysely. The production runtime now requires a real
 * PostgreSQL via {@link createPostgresDb} (main.ts fails fast without
 * `DATABASE_URL`); pglite is retained solely for the hermetic in-memory test
 * harness (see `./testing.ts`), which needs a Postgres-compatible store with no
 * external service.
 *
 * With `dataDir` the data is persisted to that directory and survives a clean
 * shutdown (`db.destroy()` runs Postgres's shutdown checkpoint); after an
 * uncontrolled crash (SIGKILL) recovery relies on Postgres WAL replay on the next
 * open. Without `dataDir` the database is in-memory (ephemeral). Note: one
 * in-process connection (no pool) — correct for pglite, but it serializes
 * concurrent queries. Mirrors {@link createPostgresDb}'s shape — the caller runs
 * {@link migrateToLatest} and closes via `db.destroy()`.
 *
 * Pass `undefined` for in-memory, NOT an empty string: an empty `dataDir` would
 * silently degrade to in-memory and lose data on restart, so it's rejected.
 */
export function createEmbeddedDb(dataDir?: string): Kysely<Database> {
  if (dataDir !== undefined && dataDir.trim() === '') {
    throw new Error(
      'createEmbeddedDb: dataDir is empty — pass undefined for an in-memory database',
    );
  }
  return new Kysely<Database>({ dialect: new PgliteDialect(new PGlite(dataDir)) });
}
