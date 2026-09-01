import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Starts (once per container) the PostgreSQL that `createTestDb` uses instead of
 * a private pglite per test file, and hands out the per-run namespace that keeps
 * two suites on one server off each other's databases.
 *
 * The server is deliberately container-scoped, not run-scoped or session-scoped.
 * Several Verity sessions share one project container, and the cost this exists
 * to remove — a WASM Postgres boot plus every migration, per test file — is paid
 * again by every session that starts its own. One cluster, reached over a Unix
 * socket in a directory the agent user owns, is shared by all of them; what
 * separates their data is the namespace in the database NAME (see
 * `packages/store/src/testing.ts`), not a separate server.
 */

/** Kept in step with `vitest.config.ts`, which imports it. */
export const MAX_TEST_WORKERS = 2;

/**
 * How many worker databases teardown looks for, which is deliberately NOT
 * `MAX_TEST_WORKERS`.
 *
 * `--maxWorkers=8` on the command line, or `VITEST_MAX_WORKERS` in the
 * environment, widens the pool without touching the config the constant above
 * lives in — and every worker past the second would then create a database on a
 * server built to outlive the run, with nothing that ever drops it. The names
 * are namespaced and the drops are `if exists`, so overshooting costs one cheap
 * statement each and removes the coupling entirely.
 */
export const TEARDOWN_WORKERS = 64;

/**
 * Debian installs the server binaries under a versioned directory that is NOT on
 * PATH; only the `pg_ctlcluster`/`pg_createcluster` wrappers are, and those want
 * root and the system cluster layout this image explicitly disables.
 *
 * Looking here and nowhere else — not on PATH — is what keeps auto-start
 * confined to the sandbox image. A developer whose laptop happens to have
 * `initdb` on PATH from Homebrew gets the unchanged pglite path rather than a
 * cluster appearing somewhere they did not ask for one.
 */
export const POSTGRES_LIB_DIR = '/usr/lib/postgresql';

/** Where the cluster and its socket live. Overridable so tests need no root. */
export const CLUSTER_ROOT = '/var/lib/verity-test-postgres';

export interface ClusterLayout {
  dataDir: string;
  socketDir: string;
  logFile: string;
}

export function clusterLayout(root: string): ClusterLayout {
  return { dataDir: join(root, 'data'), socketDir: join(root, 'sock'), logFile: join(root, 'log') };
}

/** Every binary `setUpSharedPostgres` goes on to run out of the chosen directory. */
export const REQUIRED_BINARIES: readonly string[] = ['initdb', 'pg_ctl', 'psql'];

/**
 * The newest server bin directory that has the binaries the harness runs, or
 * `undefined` when this is not a container with the package installed.
 *
 * Newest by numeric major, not by string order: a container with both 9 and 15
 * installed would otherwise pick 9, and this repo's migrations use syntax
 * (`DROP DATABASE ... WITH (FORCE)`, generated identity columns) that older
 * servers reject — a confusing failure a long way from its cause.
 */
export function findServerBinDir(
  libDir: string = POSTGRES_LIB_DIR,
  list: (dir: string) => string[] = (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  has: (path: string) => boolean = existsSync,
): string | undefined {
  return list(libDir)
    .map((entry) => ({ entry, major: Number.parseInt(entry, 10) }))
    .filter(({ major }) => Number.isFinite(major))
    .sort((a, b) => b.major - a.major)
    .map(({ entry }) => join(libDir, entry, 'bin'))
    .find((bin) => REQUIRED_BINARIES.every((binary) => has(join(bin, binary))));
}

/**
 * A libpq URL for a Unix socket, which has no host to put in the authority.
 *
 * A socket rather than a TCP port on purpose: two containers on one host cannot
 * fight over a port that is never bound, nothing outside the container can reach
 * the server at all, and `trust` authentication — which this cluster uses, since
 * it holds only test fixtures — is then bounded by filesystem permissions on a
 * directory only the agent user can enter.
 *
 * `pg` reads the `host` query parameter and lets it override the authority, and
 * `URL` leaves the query alone when `workerDatabaseUrl` rewrites the pathname to
 * this worker's database.
 *
 * The `localhost` in the authority is a placeholder that is never connected to.
 * It cannot simply be left out: a URL that carries credentials must have a host,
 * so `postgresql://dev@/postgres?host=…` is rejected by `new URL` outright —
 * which both this file and `workerDatabaseUrl` parse with.
 */
export function socketUrl(socketDir: string, user: string, database = 'postgres'): string {
  return `postgresql://${encodeURIComponent(user)}@localhost/${database}?host=${encodeURIComponent(socketDir)}`;
}

/**
 * A value distinct per run of the suite, for `VERITY_TEST_DB_NAMESPACE`.
 *
 * Random rather than derived from the pid or the clock: two runs started in the
 * same second, or a pid reused after a container restart, are exactly the
 * collisions the namespace exists to prevent. 8 hex characters is short enough to
 * leave the database name well inside PostgreSQL's 63-byte identifier limit.
 */
export function mintNamespace(bytes: (n: number) => Buffer = randomBytes): string {
  return bytes(4).toString('hex');
}

/**
 * Written without TypeScript parameter properties, and this whole file without
 * `enum`, `namespace`, or anything else that needs a transform rather than an
 * erasure. Node's type stripping is what lets `verity-sandbox.yml` import this
 * module inside the built image and call the real `setUpSharedPostgres` — the
 * only place the cluster path can be exercised end to end, since the container
 * that runs the unit tests has no server binaries. A Bash re-implementation of
 * the same steps in the workflow would drift from this file silently.
 */
class CommandError extends Error {
  command: string;
  code: number | null;
  output: string;

  constructor(command: string, code: number | null, output: string) {
    super(`${command} exited with ${String(code)}\n${output}`);
    this.name = 'CommandError';
    this.command = command;
    this.code = code;
    this.output = output;
  }
}

/**
 * The parent environment with libpq's own variables removed.
 *
 * `PGPORT`, `PGHOST`, `PGDATA`, `PGOPTIONS` and friends are read by every
 * binary here and by the postmaster itself, so a shell that exports one aims
 * this module at a server it did not start — or moves the socket file away from
 * the path `socketUrl` hands the workers. Everything this cluster needs is
 * passed on the command line, so nothing is lost by dropping them.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('PG')));
}

/**
 * How long any one cluster binary may run before it is killed.
 *
 * `pg_ctl` bounds its own wait with `-w -t 60`; `initdb` and the `psql`
 * reachability probe bound nothing. A `psql` blocked against a postmaster that
 * is half-started — or a socket directory that answers but never completes a
 * handshake — would otherwise hang `globalSetup`, which Vitest does not time
 * out, for as long as the run is allowed to live. That is strictly worse than
 * having no shared server at all, and every caller here treats a failure as
 * "fall back to pglite", so a killed binary costs the run its speed and nothing
 * else. Set well clear of the slowest step, an `initdb` on a cold container.
 */
const COMMAND_TIMEOUT_MS = 120_000;

/** Runs a binary to completion, capturing both streams for the error message. */
async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = scrubbedEnv(),
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
      // SIGKILL, not the default SIGTERM: the point of the timeout is that this
      // returns, and a process wedged on a socket is exactly the one that may
      // not act on a signal it can catch. What it can leave behind — a
      // postmaster still starting, a half-written data directory — is what the
      // next run's own state checks are there for.
      killSignal: 'SIGKILL',
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      // `signal` is how a timeout arrives here — the exit code is null, which on
      // its own reads as "crashed" and sends whoever finds it in the log looking
      // for the wrong thing.
      const detail =
        signal === null ? output : `${output}\nkilled with ${signal} after ${COMMAND_TIMEOUT_MS}ms`;
      reject(new CommandError(command, code, detail));
    });
  });
}

/**
 * Server settings for a cluster whose entire contents are recreated by the next
 * `initdb` if it is ever lost.
 *
 * `fsync=off` and friends trade crash safety for speed, which is the correct
 * trade here and nowhere else: a suite that has to re-run after a power cut is
 * not a data-loss event. The connection ceiling has to clear the pool each
 * worker opens plus the admin connections `ensureWorkerDatabase` and
 * `dropRunDatabases` open one at a time; `shared_buffers` is small because the
 * memory this saves is the memory the sandbox's cgroup limit is measured
 * against, and the fixtures are a few megabytes.
 */
export const SERVER_SETTINGS: readonly string[] = [
  'fsync=off',
  'full_page_writes=off',
  'synchronous_commit=off',
  'shared_buffers=64MB',
  'max_connections=100',
  // Nothing outside this container can reach the socket, and binding a port
  // would make two containers on one host contend for it.
  "listen_addresses=''",
  // No TCP port is opened, but the number still names the socket FILE
  // (`<dir>/.s.PGSQL.<port>`), and the postmaster takes it from `PGPORT` when
  // nothing pins it. `socketUrl` emits no port, so libpq would look for the
  // default while the server listened on an inherited one — a probe failure
  // that degrades every run in that shell to pglite, silently.
  'port=5432',
];

/**
 * The role `initdb` creates and every later run connects as.
 *
 * From the passwd entry for this uid, NOT from `$USER`. The cluster deliberately
 * outlives the run that created it, so the role is fixed at first `initdb` and
 * every run afterwards has to name that same one. `$USER` does not survive that:
 * it is set by a login shell and absent from a plain `docker exec`, so a suite
 * started one way after a cluster built the other way would connect as a role
 * that does not exist — and it would fail there, past the fallback, rather than
 * degrading to pglite.
 */
export function clusterRole(): string {
  return userInfo().username;
}

export function startArguments(layout: ClusterLayout): string[] {
  const options = [`-k ${layout.socketDir}`, ...SERVER_SETTINGS.map((s) => `-c ${s}`)].join(' ');
  return ['-D', layout.dataDir, '-l', layout.logFile, '-o', options, '-w', '-t', '60', 'start'];
}

/**
 * True when the data directory was made by a different major than `binDir` is.
 *
 * The major comes from the bin path — `<libDir>/<major>/bin`, the only shape
 * `findServerBinDir` ever returns — and `PG_VERSION` holds the other one. A
 * directory the layout does not fit, or a `PG_VERSION` that is not there yet,
 * answers false: this exists to catch a definite mismatch, and every other
 * uncertainty is already handled by the caller failing over to pglite.
 */
export function isForeignMajor(binDir: string, dataDir: string): boolean {
  const binMajor = Number.parseInt(basename(dirname(binDir)), 10);
  if (!Number.isFinite(binMajor)) return false;
  const version = join(dataDir, 'PG_VERSION');
  if (!existsSync(version)) return false;
  const dataMajor = Number.parseInt(readFileSync(version, 'utf8').trim(), 10);
  return Number.isFinite(dataMajor) && dataMajor !== binMajor;
}

/**
 * True once the cluster is running, starting it (and creating it) if needed.
 *
 * Concurrency is left to PostgreSQL rather than to a lock file. Sessions in one
 * container race here constantly — the incident that motivated this work was two
 * suites running at once — and both `initdb` and `pg_ctl start` refuse a data
 * directory that is already initialised or already has a live postmaster. So the
 * loser of either race gets a failure that means "someone else did it", and each
 * step re-checks the state before it treats its own failure as fatal.
 *
 * One narrow race is NOT covered: `initdb` writes `PG_VERSION` early, before the
 * bootstrap it guards has finished, so a session arriving in that window skips
 * its own `initdb` and then fails to start a half-built cluster. It falls back to
 * pglite for that run — slow, not broken — rather than blocking on a wait loop.
 */
async function ensureCluster(
  binDir: string,
  layout: ClusterLayout,
  user: string,
  mayReinitialize: boolean,
): Promise<void> {
  const pgCtl = join(binDir, 'pg_ctl');
  const isRunning = async (): Promise<boolean> => {
    try {
      await run(pgCtl, ['-D', layout.dataDir, 'status']);
      return true;
    } catch {
      return false;
    }
  };

  if (await isRunning()) return;

  // A data directory from a different major is not startable by these binaries,
  // and no number of retries changes that: the container would degrade to pglite
  // on every run from then on, reporting an "incompatible data directory" that
  // reads like something transient. It happens whenever the image gains a newer
  // server package. The contents are fixtures a later initdb recreates, so the
  // directory goes.
  //
  // Only for the image's own CLUSTER_ROOT, which is why the caller decides. That
  // path is created by the Dockerfile and holds nothing else; a root named by
  // VERITY_TEST_POSTGRES_ROOT is an arbitrary directory this module was pointed
  // at, and `rm -rf` on one of those on the strength of a `PG_VERSION` file is
  // not a trade to make silently. `pg_ctl status` failing is not proof the
  // directory is unowned either — an unreadable or foreign-owned data directory
  // fails exactly the same way. A foreign major under such a root falls back to
  // pglite instead, which is slow rather than destructive.
  if (mayReinitialize && isForeignMajor(binDir, layout.dataDir)) {
    rmSync(layout.dataDir, { recursive: true, force: true });
  }

  if (!existsSync(join(layout.dataDir, 'PG_VERSION'))) {
    try {
      // `--auth=trust`: see socketUrl — the boundary is the socket directory's
      // permissions, not a password this repo would then have to keep somewhere.
      await run(join(binDir, 'initdb'), [
        '-D',
        layout.dataDir,
        '-U',
        user,
        '--auth=trust',
        '--encoding=UTF8',
        '--no-sync',
      ]);
    } catch (error) {
      if (!existsSync(join(layout.dataDir, 'PG_VERSION'))) throw error;
    }
  }

  try {
    await run(pgCtl, startArguments(layout));
  } catch (error) {
    if (!(await isRunning())) throw error;
  }
}

export interface SharedPostgres {
  adminUrl: string;
  namespace: string;
  /**
   * Whether this run invented the namespace, and may therefore drop what carries
   * it. False when it arrived in `VERITY_TEST_DB_NAMESPACE`: the two documented
   * reasons to pin one — reusing a database across runs, and aiming two
   * processes at the same set — are both destroyed by a teardown that sweeps it,
   * the second of them by disconnecting the other process mid-test.
   */
  minted: boolean;
}

/**
 * The shared server this run should use, or `undefined` to leave the suite on
 * pglite.
 *
 * Three ways in, in this order. An explicit `VERITY_TEST_SHARED_POSTGRES_URL`
 * wins outright — that is CI pointing the suite at the throwaway container from
 * `.github/actions/postgres`, and this file must not second-guess it. Otherwise
 * a container with the server package gets a local cluster. Otherwise nothing
 * changes: `createTestDb` sees no URL and every file gets its own pglite, which
 * is what keeps a plain checkout on a laptop working with no service to install.
 *
 * Failure to start is not fatal. The suite is correct on pglite — slower, but
 * correct — so a broken cluster degrades to the old behaviour with a warning
 * rather than failing a run for a reason that has nothing to do with the code
 * under test.
 */
export async function setUpSharedPostgres(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn,
  // Injectable so the fallback branch can be driven from a container that has no
  // server binaries — which is every container the unit suite runs in, and would
  // otherwise leave the one path this module promises to take on failure with no
  // coverage at all.
  locateBinaries: () => string | undefined = findServerBinDir,
): Promise<SharedPostgres | undefined> {
  // A namespace supplied from outside wins. `testing.ts` documents
  // VERITY_TEST_DB_NAMESPACE as an input, and minting unconditionally would make
  // that a lie: pinning one — to reuse a database, or to point two processes at
  // the same set — would be silently overwritten here.
  const given = env.VERITY_TEST_DB_NAMESPACE;
  const minted = given === undefined || given === '';
  const namespace = minted ? mintNamespace() : given;
  const explicit = env.VERITY_TEST_SHARED_POSTGRES_URL;
  if (explicit !== undefined && explicit !== '') return { adminUrl: explicit, namespace, minted };
  if (env.VERITY_TEST_LOCAL_POSTGRES === '0') return undefined;

  const root = env.VERITY_TEST_POSTGRES_ROOT ?? CLUSTER_ROOT;
  // `pg_ctl` composes its `-o` payload into a command string and runs it through
  // a shell, so the root is not merely whitespace-split there: a `$`, a
  // backtick, a quote or a `;` in it executes as this user. A whitelist rather
  // than a blacklist, because the interesting characters are the ones nobody
  // thinks of — the default root is a fixed path and an override is a directory
  // someone chose, so nothing legitimate is outside this set. Anchored on a
  // leading `/` for the same reason: a root starting with `-` is not a path
  // there, it is another option for `pg_ctl`.
  //
  // `+` and `~` are in the set because macOS puts `$TMPDIR` under
  // `/var/folders/<hash>/T/`, where the hash is base64-ish and can contain
  // either. Without them a `mkdtempSync(join(tmpdir(), …))` root — what the
  // tests below use, and the obvious way to point this at a scratch cluster by
  // hand — is refused on a laptop while passing in CI. Neither is a shell
  // metacharacter, so neither weakens what the whitelist is for.
  if (!/^\/[A-Za-z0-9_.+~/-]*$/u.test(root)) {
    log(`[test-postgres] falling back to pglite: unusable cluster root: ${root}`);
    return undefined;
  }
  // A developer machine can have the server package installed at exactly the
  // path findServerBinDir globs — Debian and Ubuntu put it there — without ever
  // having run an image that created the cluster root. Creating a directory
  // under /var/lib is not this suite's business, so that host stays on pglite,
  // and SILENTLY: a warning every run on a working laptop is the noise this
  // module set out not to produce. Only a root the image was supposed to
  // provide, missing or unusable, is worth reporting, and that is the branch
  // below.
  if (root === CLUSTER_ROOT && !existsSync(CLUSTER_ROOT)) return undefined;

  let adminUrl: string;
  try {
    // Binary discovery and the role lookup sit INSIDE the try because both can
    // throw for reasons that have nothing to do with a cluster: readdirSync on
    // an unreadable /usr/lib/postgresql, and userInfo() on a uid with no passwd
    // entry, which is what a uid-remapped container hands you. globalSetup does
    // not guard this call, so an exception escaping here fails the entire run —
    // precisely the outcome the contract above promises never to produce.
    const binDir = locateBinaries();
    if (binDir === undefined) return undefined;

    const layout = clusterLayout(root);
    const user = clusterRole();
    adminUrl = socketUrl(layout.socketDir, user);
    mkdirSync(layout.socketDir, { recursive: true, mode: 0o700 });
    // `mode` is ignored when the directory already exists, and under `trust`
    // this directory's permissions ARE the authentication (see socketUrl). The
    // image guarantees 0700 for CLUSTER_ROOT; a root someone else created — or
    // one a umask widened — would otherwise hand every local user a superuser
    // connection.
    chmodSync(layout.socketDir, 0o700);
    await ensureCluster(binDir, layout, user, root === CLUSTER_ROOT);
    // A live postmaster is not the same claim as "this run can connect to it".
    // `pg_ctl status` reports the former; a cluster initialised by an earlier
    // image with a different role, or one whose socket directory is no longer
    // the one this URL names, passes it and then fails in every worker. Proving
    // the actual connection HERE is what keeps the documented contract — a
    // problem with the server degrades to pglite — true in general rather than
    // only for the failures ensureCluster happens to raise.
    await run(join(binDir, 'psql'), [adminUrl, '-Atc', 'select 1']);
  } catch (error) {
    log(
      `[test-postgres] falling back to pglite: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  return { adminUrl, namespace, minted };
}
