import { PGlite } from '@electric-sql/pglite';
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
class PgliteConnection implements DatabaseConnection {
  constructor(private readonly client: PGlite) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(compiledQuery.sql, [...compiledQuery.parameters]);
    return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) };
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error('the pglite dialect does not support streaming');
  }
}

class PgliteDriver implements Driver {
  constructor(private readonly client: PGlite) {}

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(new PgliteConnection(this.client));
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  async destroy(): Promise<void> {
    await this.client.close();
  }
}

class PgliteDialect implements Dialect {
  constructor(private readonly client: PGlite) {}

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
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
