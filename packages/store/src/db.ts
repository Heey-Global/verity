import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import { migrationProvider } from './migrations.js';
import type { Database } from './schema.js';

// Stable, installation-wide namespace for the one active Verity control plane.
// PostgreSQL advisory locks are scoped to one database, so unrelated databases
// on the same cluster do not contend even when they use this same key.
const CONTROL_PLANE_LOCK_CLASS = 0x42525a45; // "BRZE"
const CONTROL_PLANE_LOCK_ID = 1;

/**
 * Re-prove, after the keeper reconnected, that this Server still owns the
 * control-plane generation row.
 *
 * Resolve `true` when it does and `false` when it provably does not — a
 * successor's row is a verdict and stops this Server. REJECT when the answer is
 * unknown: an unreachable database proves nothing about who holds the
 * generation, so it is retried rather than believed. This is the same rule
 * `watchControlPlaneGeneration` already applies to its heartbeat.
 *
 * The classification lives on the caller's side because the fence and its
 * `GenerationFenceLostError` live in `@verity/server`; this package must not
 * sniff error names across that boundary to tell a verdict from a blip.
 */
export type ControlPlaneGenerationProof = () => Promise<boolean>;

export interface PostgresAdvisoryLock {
  /**
   * Downgrade exclusive activation authority to the long-lived shared hold.
   *
   * `proveGeneration` is armed here rather than at construction because there is
   * no generation to prove until one has been claimed, and claiming it requires
   * the exclusive hold this call gives up. From this point on it is what the
   * keeper re-checks after a reconnect.
   */
  activateShared(proveGeneration?: ControlPlaneGenerationProof): Promise<void>;
  /** Release the session lock and close its dedicated connection. Idempotent. */
  release(): Promise<void>;
}

/** Tuning seams for {@link holdPostgresControlPlaneLock}; defaults are production. */
export interface PostgresControlPlaneLockOptions {
  readonly reconnectBudgetMs?: number;
  readonly reconnectIntervalMs?: number;
  /** Injected in tests so a budget can expire without real elapsed time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PostgresControlPlaneFence {
  readonly generation: number;
  readonly holderId: string;
  readonly operationId: string;
}

/** Raised when another live PostgreSQL session already owns the process lock. */
export class PostgresAdvisoryLockHeldError extends Error {
  constructor() {
    super('another Server holds the PostgreSQL control-plane process lock');
    this.name = 'PostgresAdvisoryLockHeldError';
  }
}

/**
 * Raised when the control-plane database stayed unreachable for the whole
 * reconnect budget. Deliberately NOT a takeover: nothing was observed to take
 * anything. It is the point at which "keep waiting" stops being the better
 * answer than "exit and let the supervisor restart a Server that starts clean".
 */
export class PostgresControlPlaneUnreachableError extends Error {
  constructor(
    readonly budgetMs: number,
    cause: unknown,
  ) {
    super(
      `the PostgreSQL control plane stayed unreachable for ${Math.round(budgetMs / 1000)}s; ` +
        'control-plane authority could not be re-proved',
      { cause },
    );
    this.name = 'PostgresControlPlaneUnreachableError';
  }
}

/**
 * Raised when re-proving the generation showed it belongs to someone else.
 * This is the ONLY keeper error that proves a takeover, so it is a class of its
 * own: the caller must be able to recognise a real takeover instead of assuming
 * one for every error it does not otherwise know, which is how the incident
 * came to be logged as a takeover that never happened.
 */
export class PostgresControlPlaneGenerationTakenError extends Error {
  constructor(cause: unknown) {
    super('the control-plane generation is held by another Server', { cause });
    this.name = 'PostgresControlPlaneGenerationTakenError';
  }
}

/**
 * How long the keeper keeps trying to reconnect and re-prove before it treats
 * silence as a verdict, and how often it retries inside that window.
 *
 * DERIVED FROM MEASUREMENT, not chosen. Against `postgres:18-alpine` at this
 * deployment's own limits (`mem_limit: 1g`, `cpus: 1` — deploy/docker-compose.yml)
 * with a 1.1 GB database and ~1 GB of WAL to replay, the time from the container
 * being restarted to the first accepted connection was:
 *
 *   - graceful `docker restart`:      0.29 – 0.48 s  (n=8)
 *   - `docker rm -f` + recreate:      0.46 – 1.92 s  (n=3, the Renovate path)
 *   - `SIGKILL` + start, WAL replay:  8.27 – 12.11 s (n=3, the worst case)
 *
 * Crash recovery is the bound that matters and it is itself bounded by
 * `max_wal_size` (1 GB by default), so ~12 s is close to the structural worst
 * case for this configuration rather than the worst case observed.
 *
 * The budget is not set to that number. `deploy/docker-compose.yml` already
 * states what this deployment considers a tolerable Postgres start: the
 * healthcheck's `start_period: 10s` plus `interval: 5s × retries: 20` means
 * Docker itself waits up to 110 s before calling Postgres unhealthy. A keeper
 * that gave up sooner would kill the Server over a database the deployment it
 * runs in still considers to be starting. 120 s clears that, and is ~10× the
 * measured worst case.
 *
 * Overshooting costs a longer wait before a self-healing restart; undershooting
 * reproduces the incident this exists to prevent. The asymmetry is why it is
 * generous.
 */
export const CONTROL_PLANE_RECONNECT_BUDGET_MS = 120_000;
export const CONTROL_PLANE_RECONNECT_INTERVAL_MS = 1_000;

/**
 * Per-attempt cap on the connect phase of a keeper session.
 *
 * node-postgres defaults to NO connection timeout. A refused or reset socket
 * fails fast, but a *blackholed* database — a dropped compose network, a host
 * that answers SYN with silence — leaves `connect()` pending indefinitely. That
 * wait would sit OUTSIDE {@link CONTROL_PLANE_RECONNECT_BUDGET_MS}: the keeper
 * would never reconnect, never call `onLost`, and never evaluate its own
 * deadline, so the advertised budget would be fiction and `release()` could
 * block on the in-flight recovery forever.
 *
 * Ten seconds is long enough for a loaded or still-starting PostgreSQL to
 * finish a handshake, and short enough that the budget still affords about a
 * dozen attempts.
 */
export const CONTROL_PLANE_CONNECT_TIMEOUT_MS = 10_000;

/**
 * PostgreSQL error codes and socket errno values that mean "not reachable /
 * not ready yet", never "you have been replaced".
 *
 * Every value here was observed in the measurements above, driving a real
 * `postgres:18-alpine` through restart, recreate and SIGKILL:
 * `ECONNREFUSED` (container gone), `ECONNRESET` (socket cut mid-flight), and
 * SQLSTATE `57P03` — "the database system is starting up" / "is not yet
 * accepting connections", which Postgres serves while it replays WAL. The rest
 * are the neighbouring cases in the same classes (`08…` connection exception,
 * DNS, timeouts) that a compose-network restart can produce.
 */
const CONNECTION_CLASS_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P03', // cannot_connect_now — starting up / not yet accepting connections
  '57P01', // admin_shutdown — terminating connection due to administrator command
  '57P02', // crash_shutdown
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

/**
 * True when `error` says the database could not be reached or is not ready —
 * the class of failure that must be waited out rather than acted on.
 */
export function isPostgresConnectionClassError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_CLASS_CODES.has(code)) return true;
  // pg reports a socket that died with no query in flight as a plain Error with
  // no code at all ("Connection terminated unexpectedly"), and an expiry of
  // `connectionTimeoutMillis` as the equally bare "timeout expired". Both mean
  // the database did not answer — silence, not a verdict from it — so both are
  // worth waiting out rather than exiting on.
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    /connection terminated|server closed the connection|timeout expired/i.test(message)
  );
}

/**
 * Hold the control-plane advisory lock on one dedicated PostgreSQL session.
 *
 * The lock is released by PostgreSQL itself if the process, socket, or database
 * dies. A generation row can be repaired or restored; this session lock cannot
 * be forged by editing data, so no second Server can claim authority while the
 * incumbent remains connected.
 *
 * WHAT MAY CALL `onLost`, AND WHY NOTHING ELSE MAY
 * ------------------------------------------------
 * `onLost` ends the Server. It is therefore reserved for a verdict this keeper
 * has actually established:
 *
 *   - a lost race for the mode it was entitled to — see the reproof rules
 *     below; the session lock is unforgeable, so losing it names a real
 *     competitor;
 *   - a `proveGeneration` that answered `false` — the generation row provably
 *     belongs to someone else;
 *   - the reconnect budget expiring — see
 *     {@link CONTROL_PLANE_RECONNECT_BUDGET_MS}.
 *
 * A transport error is none of those. It used to be treated as one: this
 * client's `'error'` event called `onLost` unconditionally, so a Postgres
 * restart under a live Server (a Renovate digest bump applied by the nightly
 * converge, in the incident this guards against) was read as a takeover. The
 * Server exited 1, came back sealed, and every sandbox lost its signing and
 * token endpoints for hours. Nobody had taken anything.
 *
 * WHAT THIS LOCK IS FOR
 * ---------------------
 * It is an admission gate against *successor Servers*, not a per-write
 * correctness gate — writes are fenced by the generation row. The two modes are
 * two different jobs:
 *
 *   - EXCLUSIVE is the mutex around the claim procedure. It is held only across
 *     migrate-and-claim, and it is the sole reason `claimControlPlaneGeneration`
 *     may forward-fence a row left `active` by a hard kill: holding it proves no
 *     other live Server's session exists, so the row cannot belong to anyone.
 *   - SHARED is a liveness advertisement, held for the rest of the process's
 *     life. Its only job is to make some *later* `pg_try_advisory_lock` fail.
 *     Every serving-pool connection takes the same shared lock in
 *     `createPostgresDb`'s `verify` hook for exactly this reason, so a successor
 *     cannot activate while any old serving connection is still usable.
 *
 * WHY REPROOF DOES NOT RE-TAKE EXCLUSIVE
 * --------------------------------------
 * Because exclusive asks "is any other session alive on this key?", which is a
 * *starting* Server's question. An incumbent that already owns a generation must
 * never ask it, because its own serving pool is one of the answers.
 *
 * During the Postgres restart this change exists to survive, every session dies
 * at once and both the keeper and the pool reconnect concurrently. The keeper
 * backs off a second between attempts; the pool opens connections on demand and
 * `/sessions` is polled every two seconds per device, so the pool ordinarily
 * wins. Re-taking exclusive there returns false against the Server's own traffic
 * and reports a successor that does not exist — the Server would kill itself
 * with its own polling, which is the very incident this file guards against.
 *
 * So reproof restores the mode that was actually lost, and asks the question
 * that mode is entitled to ask:
 *
 *   - Before `activateShared`, the keeper is still inside the claim window and
 *     the exclusive hold IS its whole state. No fenced serving pool exists yet
 *     (`main.ts` migrates on a pool built WITHOUT a fence, and the fenced one is
 *     only built after the claim returns), so nothing of this Server's holds
 *     shared and exclusive is both correct and required.
 *   - After `activateShared`, it re-takes SHARED, which is compatible with its
 *     own pool and with nothing else that matters — and then rests the verdict
 *     on the generation row, which is the per-write authority anyway.
 *
 * A GENUINE SUCCESSOR STILL KILLS THIS SERVER, by one of two paths. A successor
 * that finished claiming holds shared, so this keeper re-takes shared happily
 * and then `proveGeneration` answers `false` against the row the successor
 * advanced. A successor still inside its claim holds EXCLUSIVE, so
 * `pg_try_advisory_lock_shared` returns false — and only `takeExclusive` ever
 * takes this key exclusively, so that observation names a competing Server as
 * unambiguously as the old exclusive race did. There is no instant in between:
 * a successor acquires shared before it releases exclusive, so it never holds
 * nothing.
 *
 * The order below matters. Take the lock first, because it is the gate; then
 * the generation row, which only means anything while the gate is held.
 */
export async function holdPostgresControlPlaneLock(
  connectionString: string,
  onLost: (error: Error) => void,
  options: PostgresControlPlaneLockOptions = {},
): Promise<PostgresAdvisoryLock> {
  const budgetMs = options.reconnectBudgetMs ?? CONTROL_PLANE_RECONNECT_BUDGET_MS;
  const intervalMs = options.reconnectIntervalMs ?? CONTROL_PLANE_RECONNECT_INTERVAL_MS;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));

  let client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  let released = false;
  let shared = false;
  let lossReported = false;
  let proveGeneration: ControlPlaneGenerationProof | undefined;
  let recovering: Promise<void> | undefined;

  const reportLoss = (error: Error): void => {
    if (released || lossReported) return;
    lossReported = true;
    onLost(error);
  };

  const takeExclusive = async (target: pg.Client): Promise<void> => {
    const result = await target.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1::integer, $2::integer) as acquired',
      [CONTROL_PLANE_LOCK_CLASS, CONTROL_PLANE_LOCK_ID],
    );
    if (result.rows[0]?.acquired !== true) throw new PostgresAdvisoryLockHeldError();
  };

  /**
   * Re-take the long-lived shared hold on a reconnected session.
   *
   * `pg_try_advisory_lock_shared`, for two reasons. The `try` form, because the
   * blocking `pg_advisory_lock_shared` would park inside a backend that has no
   * budget and no cancellation, behind a successor's exclusive hold. And the
   * SHARED mode, because that is the mode this keeper lost — the exclusive form
   * would contend with this Server's own serving-pool connections, which hold
   * shared on this same key and reconnect in the same instant.
   *
   * `false` therefore means one specific thing: some session holds this key
   * EXCLUSIVELY, and only {@link takeExclusive} ever does that, so it is a
   * Server inside the claim procedure. That is a competitor, and by then it may
   * already have forward-fenced this Server's generation row.
   */
  const retakeShared = async (target: pg.Client): Promise<void> => {
    const result = await target.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock_shared($1::integer, $2::integer) as acquired',
      [CONTROL_PLANE_LOCK_CLASS, CONTROL_PLANE_LOCK_ID],
    );
    if (result.rows[0]?.acquired !== true) throw new PostgresAdvisoryLockHeldError();
  };

  // PostgreSQL lets this session acquire shared while it owns exclusive.
  // Releasing exclusive afterwards leaves no instant in which a successor could
  // slip between activation and the long-lived shared hold.
  const downgradeToShared = async (target: pg.Client): Promise<void> => {
    await target.query('select pg_advisory_lock_shared($1::integer, $2::integer)', [
      CONTROL_PLANE_LOCK_CLASS,
      CONTROL_PLANE_LOCK_ID,
    ]);
    await target.query('select pg_advisory_unlock($1::integer, $2::integer)', [
      CONTROL_PLANE_LOCK_CLASS,
      CONTROL_PLANE_LOCK_ID,
    ]);
  };

  /**
   * Reconnect and re-prove authority, or report a loss. Runs at most once at a
   * time; a transport error raised while it is already running is the same
   * outage and is ignored.
   */
  const reprove = async (cause: Error): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    // Deliberately not awaited. `end()` settles only once the server has
    // acknowledged the Terminate and the socket has closed, and the failure
    // this function exists to survive is exactly the one where that never
    // happens: a half-open or blackholed connection stalls until the kernel's
    // TCP timeout, which is far longer than `budgetMs` and outside it. Awaiting
    // here would mean the keeper never reconnects, never reports a loss, and
    // never honours its own budget — the outage would be indefinite. The old
    // socket is already unusable, so nothing below depends on it being closed
    // first, and `transportErrorListenerFor` is keyed on identity, so once
    // `client` is replaced this connection can no longer report anything.
    void client.end().catch(() => undefined);
    for (;;) {
      if (released || lossReported) return;
      let next: pg.Client | undefined;
      try {
        next = new pg.Client({
          connectionString,
          connectionTimeoutMillis: CONTROL_PLANE_CONNECT_TIMEOUT_MS,
        });
        await next.connect();
        // Attached before the first query: node treats an `'error'` event with
        // no listener as an uncaught exception, and this candidate can die in
        // the gap between statements. Re-entry is harmless — the handler sees
        // this recovery already in flight and leaves it to the loop below.
        next.on('error', transportErrorListenerFor(next));
        // Restore the mode that was lost, never a stronger one — see "WHY
        // REPROOF DOES NOT RE-TAKE EXCLUSIVE" above. Asking for exclusive here
        // would lose to this Server's own serving pool.
        if (shared) await retakeShared(next);
        else await takeExclusive(next);
        // Only meaningful once a generation has been claimed. Before that the
        // exclusive hold IS the whole of this keeper's state, and re-taking it
        // has already restored it.
        if (proveGeneration !== undefined && !(await proveGeneration()))
          throw new GenerationProofFailed();
        client = next;
        return;
      } catch (error) {
        // The listener stays attached deliberately (see
        // `transportErrorListenerFor`): this candidate never became `client`,
        // so the listener is already inert by identity, and removing it would
        // leave a dying socket able to emit `'error'` with no listener at all.
        // Not awaited, for the same reason as the incumbent above: a candidate
        // that failed mid-handshake can be just as unclosable, and stalling
        // here would burn the retry budget without ever retrying.
        void next?.end().catch(() => undefined);
        if (error instanceof PostgresAdvisoryLockHeldError) return reportLoss(error);
        if (error instanceof GenerationProofFailed)
          return reportLoss(new PostgresControlPlaneGenerationTakenError(cause));
        // Only an unreachable database is worth waiting out. A rejected
        // credential, a protocol or query error, or a bug thrown out of
        // `proveGeneration` is a real answer, not silence — retrying it for the
        // whole budget would delay the exit by two minutes and then bury the
        // actual cause under a "stayed unreachable" verdict that is untrue.
        // `openControlPlaneProcessLock` applies this same rule at startup.
        if (!isPostgresConnectionClassError(error))
          return reportLoss(error instanceof Error ? error : new Error(String(error)));
        if (Date.now() >= deadline)
          return reportLoss(new PostgresControlPlaneUnreachableError(budgetMs, cause));
        await sleep(intervalMs);
      }
    }
  };

  /**
   * Build the `'error'` listener belonging to one specific client.
   *
   * The listener is never removed, because node turns an `'error'` event with
   * no listener into an uncaught exception and a socket that has just died can
   * still emit after it was ended and replaced. So instead of detaching, it
   * checks identity: only the client this keeper is *currently* using can
   * report an outage.
   *
   * A late event from a client that recovery already superseded is history. If
   * it were acted on, `reprove` would end the healthy connection that recovery
   * had just installed — dropping the advisory lock and opening exactly the
   * window to a successor that this change exists to close.
   */
  const transportErrorListenerFor =
    (owner: pg.Client) =>
    (error: Error): void => {
      if (owner !== client) return;
      if (released || lossReported || recovering !== undefined) return;
      recovering = reprove(error).finally(() => {
        recovering = undefined;
      });
    };

  client.on('error', transportErrorListenerFor(client));
  try {
    await takeExclusive(client);
  } catch (error) {
    released = true;
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    activateShared: async (proof?: ControlPlaneGenerationProof): Promise<void> => {
      if (released) throw new Error('control-plane process lock is already released');
      // Armed before the downgrade, so a socket that dies mid-downgrade is
      // re-proved against the generation this Server just claimed.
      if (proof !== undefined) proveGeneration = proof;
      if (shared) return;
      await downgradeToShared(client);
      shared = true;
    },
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      await recovering;
      // The `'error'` listener is left attached on purpose. `released` is
      // already true, so it is inert, and the unlock and `end()` below are
      // exactly when a dying socket is most likely to emit — with no listener
      // that would be an uncaught exception instead of a no-op.
      try {
        await client.query(
          shared
            ? 'select pg_advisory_unlock_shared($1::integer, $2::integer)'
            : 'select pg_advisory_unlock($1::integer, $2::integer)',
          [CONTROL_PLANE_LOCK_CLASS, CONTROL_PLANE_LOCK_ID],
        );
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

/** Internal marker: `proveGeneration` answered `false`. Never escapes this module. */
class GenerationProofFailed extends Error {}

/** Open a Kysely instance backed by a real Postgres pool (production path). */
export function createPostgresDb(
  connectionString: string,
  controlPlaneFence?: PostgresControlPlaneFence,
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    ...(controlPlaneFence === undefined
      ? {}
      : {
          verify: (client: pg.PoolClient, done: (error?: Error) => void): void => {
            void (async () => {
              // `pg.Pool` verifies once when it creates a physical connection.
              // That connection retains this shared session lock across every
              // later checkout, so a successor's exclusive activation cannot
              // overlap any reused old connection. A replacement connection is
              // verified anew and must match the still-current generation.
              await client.query('select pg_advisory_lock_shared($1::integer, $2::integer)', [
                CONTROL_PLANE_LOCK_CLASS,
                CONTROL_PLANE_LOCK_ID,
              ]);
              const result = await client.query<{ held: boolean }>(
                `select exists (
                   select 1 from control_plane_generation
                   where singleton = true and generation = $1 and holder_id = $2
                     and operation_id = $3 and state = 'active'
                 ) as held`,
                [
                  controlPlaneFence.generation,
                  controlPlaneFence.holderId,
                  controlPlaneFence.operationId,
                ],
              );
              if (result.rows[0]?.held !== true) {
                await client.query('select pg_advisory_unlock_shared($1::integer, $2::integer)', [
                  CONTROL_PLANE_LOCK_CLASS,
                  CONTROL_PLANE_LOCK_ID,
                ]);
                throw new Error('control-plane generation fence is not held');
              }
            })().then(() => done(), done);
          },
        }),
  });
  // A pg Pool emits 'error' when an IDLE pooled client's backend connection dies
  // out-of-band — Postgres terminating an idle-in-transaction session (our
  // idle_in_transaction_session_timeout guardrail), a DB restart, or a network
  // blip. Node treats an 'error' event with NO listener as an uncaught exception
  // and CRASHES the process, so a listener here is mandatory, not optional. The
  // pool already discards the dead client and hands out a fresh one on the next
  // checkout, so we only log and recover — never rethrow.
  pool.on('error', (error) => {
    console.error(`verity: idle postgres client error (pool recovered): ${String(error)}`);
  });
  // ...and that handler covers only the IDLE half of a connection's life. `pg`
  // attaches the listener behind `pool.on('error')` when a client is released
  // back into the pool and REMOVES it again at checkout, so for the whole time a
  // connection is checked out — every Kysely transaction, every `verify` above,
  // and every gap between two statements of one — the client carries no 'error'
  // listener at all. A `FATAL 57P01` ("terminating connection due to
  // administrator command") landing in that gap is an uncaught exception that
  // kills the Server: precisely the PostgreSQL restart this control plane exists
  // to survive, turned back into a crash.
  //
  // 'connect' fires once per physical connection and, crucially, BEFORE checkout
  // removes the idle listener; `pg` only ever removes the listener it added
  // itself, so this one stays attached for the connection's whole life and
  // closes the gap without racing it. It only has to EXIST — the error is still
  // delivered to whoever is owed it (an in-flight query rejects, a `verify`
  // fails its callback, the next statement reports a client that is no longer
  // queryable) and the pool still discards the connection either way. So log and
  // recover, exactly as above, and never rethrow.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      // `pg`'s idle listener is attached exactly when the client is sitting in
      // the pool, and it reports through the `pool.on('error')` handler above.
      // Its presence alongside this one therefore means that path already owns
      // this error, and logging here too would double every idle disconnect
      // under a line that says "checked out" when the client is not. Only the
      // LOGGING is conditional: this listener still exists in both states, which
      // is the whole point, so a wrong guess costs a log line and never a crash.
      if (client.listenerCount('error') > 1) return;
      console.error(`verity: postgres client error while checked out: ${String(error)}`);
    });
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Kysely's default bookkeeping table, read directly by {@link executedLedger}. */
const MIGRATION_TABLE = 'kysely_migration';

/** Raised when the database carries a generation this build did not promise to read. */
export class SchemaGenerationAheadError extends Error {
  constructor(
    readonly ahead: string,
    readonly forwardMax: string,
  ) {
    super(
      `database schema generation "${ahead}" is newer than this build's maximum ` +
        `readable generation "${forwardMax}"`,
    );
    this.name = 'SchemaGenerationAheadError';
  }
}

export interface MigrateOptions {
  /**
   * The highest migration key this build PROMISES it can read and write (ADR 0008
   * D9). Absent means "no promise": the build accepts only a database whose
   * ledger it fully knows, which is the behaviour every ordinary release ships.
   *
   * A release-controlled bridge build states a later key here so the generation
   * it is rolled back FROM stays startable. Without this the promise is
   * unkeepable — see {@link migrateToLatest}.
   */
  readonly forwardMax?: string;
}

/**
 * The raw migration ledger, including names this build knows nothing about.
 *
 * Deliberately not `getExecutedMigrations`: that goes through Kysely's
 * `getMigrations`, which projects the ledger onto the PROVIDER's list, so a
 * database that is ahead of this build reads back as if it were exactly at this
 * build's generation. The one question asked here is the one that projection
 * cannot answer.
 *
 * An absent table means an empty ledger — the same thing Kysely's own inspection
 * reports for a database that has never been migrated.
 */
async function executedLedger(db: Kysely<Database>): Promise<string[]> {
  try {
    const rows = await sql<{ name: string }>`select name from ${sql.table(
      MIGRATION_TABLE,
    )}`.execute(db);
    return rows.rows.map((row) => row.name);
  } catch {
    return [];
  }
}

/**
 * Run all pending migrations. Kysely sets `error` whenever a migration fails, so
 * a failure always throws here — a broken schema never silently leaves the store
 * half-migrated. The `provider` parameter is injectable for testing.
 *
 * ADR 0008 D9 requires a release to stay rollback-safe across an additive
 * migration: release N advances the schema, and if N fails its readiness window
 * the deployment goes back to N−1, which then has to START against the database
 * N already migrated. Kysely refuses that outright — `#ensureNoMissingMigrations`
 * throws `corrupted migrations: previously executed migration <name> is missing`
 * for ANY executed name the running build does not carry — so, before this
 * function grew {@link MigrateOptions.forwardMax}, the D9 rollback contract could
 * not hold for a single migration, and the `VERITY_SCHEMA_FORWARD_MAX` bridge
 * stamp widened a window nothing ever consulted at startup.
 *
 * The tolerance is deliberately narrow, because "the ledger has a name I do not
 * know" is also what a genuinely corrupt or downgraded database looks like:
 *
 *   - every unknown name must sort STRICTLY AFTER this build's own latest
 *     migration. An unknown name interleaved with ours is a different database,
 *     not a newer one, and still fails Kysely's check;
 *   - this build must have nothing pending. If our own set is not fully applied,
 *     running it now would write generations BELOW ones already applied, which
 *     is the ordering Kysely's second check exists to prevent;
 *   - the NEWEST unknown name must be within `forwardMax`. Judging by any other
 *     row would accept a batch whose tail is past the promise on the strength of
 *     its head being inside it. Absent the promise, nothing is tolerated —
 *     forward compatibility is asserted per release and reviewed, never inferred
 *     from the fact that a database is ahead.
 *
 * When all three hold there is, by construction, nothing to run: every migration
 * this build owns is already in the ledger.
 *
 * WHERE the decision is taken matters as much as what it decides, and this is
 * why it lives in {@link forwardTolerantProvider} rather than ahead of the
 * migrator. Kysely calls `provider.getMigrations()` from `#getState`, which runs
 * inside `runWithLock` (`kysely/dist/migration/migrator.js` — `#runMigrations`
 * acquires `pg_advisory_lock` on a dedicated connection, then opens the
 * transaction, then calls `run`). So the ledger read below happens while THIS
 * process holds the same migration lock every other Verity Server takes, and a
 * newer generation that is mid-migration is either finished or still blocked —
 * never observable half-applied. Deciding before the migrator, on an unlocked
 * read, would let a Server start against a schema another Server is still
 * writing, which is strictly worse than the crash loop this whole mechanism
 * exists to end: a crash loop is loud and self-healing, a Server serving on
 * half-applied structures is neither.
 *
 * The cost is one extra `select name from kysely_migration` per startup, issued
 * while the migration lock is held, on a second pooled connection. It needs the
 * pool to hand out at least two connections (pg's default max is 10, and
 * `createPostgresDb` does not lower it) — do not cap that pool at one.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  provider: MigrationProvider = migrationProvider,
  options: MigrateOptions = {},
): Promise<void> {
  const migrator = new Migrator({ db, provider: forwardTolerantProvider(db, provider, options) });
  const { error } = await migrator.migrateToLatest();
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error('migration failed', { cause: error });
  }
}

/**
 * A tolerated generation, present in the ledger and absent from this build.
 *
 * It is only ever synthesized for a name the read below found ALREADY EXECUTED,
 * so Kysely classifies it as executed and never runs it. `up` rejects rather
 * than resolving because the one path that would reach it is a ledger that lost
 * the row between the read below and Kysely's own — and applying a no-op then
 * would write a ledger row claiming this build applied a migration it does not
 * carry. Refusing loudly is the only safe answer to that.
 */
const TOLERATED_GENERATION: Migration = {
  up: () =>
    Promise.reject(
      new Error(
        'refusing to apply a migration that belongs to a newer Server generation: ' +
          'this build only promised to READ it',
      ),
    ),
  down: () =>
    Promise.reject(
      new Error(
        'refusing to revert a migration that belongs to a newer Server generation: ' +
          'this build only promised to READ it',
      ),
    ),
};

/**
 * `provider`, widened to accept a database whose ledger is ahead of this build
 * within `options.forwardMax` — see {@link migrateToLatest} for the rules and for
 * why this indirection is what puts the decision under Kysely's migration lock.
 *
 * Returning `migrations` unchanged is the fail-closed answer: Kysely's own
 * `#ensureNoMissingMigrations`/`#ensureMigrationsInOrder` then reject the ledger
 * with a message that names the offending row, which is the diagnostic operators
 * already know.
 */
function forwardTolerantProvider(
  db: Kysely<Database>,
  provider: MigrationProvider,
  options: MigrateOptions,
): MigrationProvider {
  return {
    getMigrations: async () => {
      const migrations = await provider.getMigrations();
      const known = Object.keys(migrations);
      const executed = await executedLedger(db);
      const unknown = executed.filter((name) => !known.includes(name)).sort();
      if (unknown.length === 0) return migrations;
      const latestKnown = [...known].sort().at(-1);
      const ahead = unknown.at(-1);
      if (
        latestKnown === undefined ||
        ahead === undefined ||
        known.some((name) => !executed.includes(name)) ||
        !unknown.every((name) => name > latestKnown)
      )
        return migrations;
      // No promise means the build vouches for its own generation and nothing
      // beyond it, so this comparison then always refuses — which is what every
      // ordinary release must do.
      const forwardMax = options.forwardMax ?? latestKnown;
      if (ahead > forwardMax) throw new SchemaGenerationAheadError(ahead, forwardMax);
      return {
        ...migrations,
        ...Object.fromEntries(unknown.map((name) => [name, TOLERATED_GENERATION])),
      };
    },
  };
}
