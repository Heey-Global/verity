import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';

import {
  clusterLayout,
  clusterRole,
  CLUSTER_ROOT,
  findServerBinDir,
  isForeignMajor,
  mintNamespace,
  POSTGRES_LIB_DIR,
  REQUIRED_BINARIES,
  scrubbedEnv,
  SERVER_SETTINGS,
  setUpSharedPostgres,
  socketUrl,
  startArguments,
} from './test-postgres.js';
import { workerDatabaseUrl } from '../packages/store/src/testing.js';

/**
 * These cover the parts that decide WHERE the suite connects and WHICH databases
 * teardown will drop. The cluster lifecycle itself (initdb, pg_ctl) is not
 * exercised here: the container running this suite has no server binaries, and
 * the branch that matters when it does — losing an initdb/start race to another
 * session — needs two real processes to mean anything. That path is validated by
 * the sandbox suite running against the image, not by a mock of `spawn` that
 * would only assert the arguments this file already asserts directly.
 */
describe('findServerBinDir', () => {
  const layout = (dirs: string[], present: string[]) =>
    findServerBinDir(
      '/lib/pg',
      () => dirs,
      (path) => present.includes(path),
    );

  it('picks the newest major, not the first or the lexicographically largest', () => {
    const dirs = ['9', '15', '13'];
    const present = ['/lib/pg/9/bin/initdb', '/lib/pg/9/bin/pg_ctl', '/lib/pg/9/bin/psql'];
    // String order would answer '9' here and iteration order '9' as well, so a
    // wrong implementation passes unless the newest is also the one whose
    // binaries are checked last.
    expect(
      layout(dirs, [
        ...present,
        '/lib/pg/15/bin/initdb',
        '/lib/pg/15/bin/pg_ctl',
        '/lib/pg/15/bin/psql',
      ]),
    ).toBe('/lib/pg/15/bin');
  });

  it.each(REQUIRED_BINARIES)('skips a version directory with no %s in it', (missing) => {
    // Debian splits these across packages — postgresql-client-15 brings a bin
    // directory with `psql` and no `initdb`, and a server install without the
    // client is the mirror image. Selecting either fails partway through cluster
    // setup instead of falling back to pglite, and the `psql` case fails at the
    // reachability probe, after the cluster is already running.
    const complete = (major: string) =>
      REQUIRED_BINARIES.map((binary) => `/lib/pg/${major}/bin/${binary}`);
    expect(
      layout(
        ['15', '13'],
        [...complete('15').filter((path) => !path.endsWith(`/${missing}`)), ...complete('13')],
      ),
    ).toBe('/lib/pg/13/bin');
  });

  it('ignores non-version entries', () => {
    // Both entries are given a COMPLETE bin directory, so the version filter is
    // the only thing that can reject them. Passing empty lists here would let
    // this test pass with that filter deleted.
    expect(
      layout(
        ['README', 'lost+found'],
        ['README', 'lost+found'].flatMap((entry) =>
          REQUIRED_BINARIES.map((binary) => `/lib/pg/${entry}/bin/${binary}`),
        ),
      ),
    ).toBeUndefined();
  });

  it('answers undefined when nothing is installed', () => {
    expect(layout([], [])).toBeUndefined();
  });
});

/**
 * `pg-connection-string` is what `pg.Pool` parses connection strings with, so
 * asserting through it pins the behaviour that actually decides whether a worker
 * reaches the socket — a hand-rolled check of the string's shape would pass on a
 * URL `pg` reads differently. It arrives as a transitive dependency of `pg`;
 * the root `package.json` declares it too, because a test importing a package
 * nothing declares breaks the moment the dependency it rides in on reorganises.
 */
describe('socketUrl', () => {
  const url = socketUrl('/var/lib/verity-test-postgres/sock', 'dev');

  it('carries the socket directory as the host parameter, not as an authority', () => {
    // A path cannot be a URL host. `pg` reads `?host=` instead and lets it win
    // over the placeholder authority; getting this wrong produces a TCP
    // connection to localhost rather than a socket connection.
    expect(parse(url).host).toBe('/var/lib/verity-test-postgres/sock');
    expect(new URL(url).searchParams.get('host')).toBe('/var/lib/verity-test-postgres/sock');
  });

  it('survives the pathname rewrite workerDatabaseUrl performs on it', () => {
    // The two functions are developed apart and composed only at runtime: this is
    // the seam. If rewriting the pathname dropped the query, every worker would
    // connect over TCP to no host at all.
    const worker = parse(workerDatabaseUrl(url, '2', 'abc123'));
    expect(worker.database).toBe('verity_test_abc123_w2');
    expect(worker.host).toBe('/var/lib/verity-test-postgres/sock');
    expect(worker.user).toBe('dev');
  });
});

describe('mintNamespace', () => {
  it('produces an identifier-safe value short enough to leave the name room', () => {
    const namespace = mintNamespace();
    expect(namespace).toMatch(/^[0-9a-f]{8}$/);
    // 63 bytes is where PostgreSQL truncates silently; the guard in testing.ts
    // hashes to stay under it, and a namespace that triggered that guard would
    // make the name unreadable for no reason.
    expect(workerDatabaseUrl('postgres://h/postgres', '1', namespace)).toContain(
      `verity_test_${namespace}_w1`,
    );
  });

  it('maps distinct draws to distinct namespaces', () => {
    // Driven through the injected source rather than by sampling the real RNG:
    // 200 draws from 2^32 collide about once in 200 000 runs, which is a flake
    // this suite would eventually produce and nobody would be able to explain.
    const namespaces = Array.from({ length: 200 }, (_, index) =>
      mintNamespace(() => Buffer.of(0, 0, index >> 8, index & 0xff)),
    );
    expect(new Set(namespaces).size).toBe(200);
  });
});

describe('isForeignMajor', () => {
  const dataDir = () => mkdtempSync(join(tmpdir(), 'verity-test-postgres-'));

  it('reports a data directory left behind by a different major', () => {
    // The permanent-degradation case: the image gains a newer server package, or
    // a persisted root outlives one, and `pg_ctl start` then refuses the data
    // directory on every run with a message that reads transient.
    const dir = dataDir();
    try {
      writeFileSync(join(dir, 'PG_VERSION'), '13\n');
      expect(isForeignMajor('/usr/lib/postgresql/15/bin', dir)).toBe(true);
      expect(isForeignMajor('/usr/lib/postgresql/13/bin', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers false for anything it cannot read as a version', () => {
    // Uncertainty is not a licence to delete a data directory. Every case here
    // leaves it alone and lets the caller fail over to pglite instead.
    const dir = dataDir();
    try {
      expect(isForeignMajor('/usr/lib/postgresql/15/bin', dir)).toBe(false);
      writeFileSync(join(dir, 'PG_VERSION'), 'not-a-number');
      expect(isForeignMajor('/usr/lib/postgresql/15/bin', dir)).toBe(false);
      expect(isForeignMajor('/somewhere/else/bin', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('clusterRole', () => {
  it('ignores $USER, which the cluster it has to match cannot depend on', () => {
    // initdb fixes the role once, on the first run in a container. A later run
    // reaching the same cluster from a non-login `docker exec` — where $USER is
    // absent — has to arrive at the same answer, or every worker fails with a
    // role that does not exist, past the point where pglite is still an option.
    const role = clusterRole();
    const restore = process.env.USER;
    try {
      process.env.USER = 'someone-else';
      expect(clusterRole()).toBe(role);
      delete process.env.USER;
      expect(clusterRole()).toBe(role);
    } finally {
      if (restore === undefined) delete process.env.USER;
      else process.env.USER = restore;
    }
  });
});

describe('startArguments', () => {
  const args = startArguments(clusterLayout('/root'));

  it('waits for the server to accept connections before returning', () => {
    // Without -w, pg_ctl returns while the postmaster is still starting and the
    // first worker's connection is refused — a flake that looks like a broken
    // test rather than a race in the harness.
    expect(args).toContain('-w');
  });

  it('binds the socket inside the run root and no TCP port', () => {
    const options = args[args.indexOf('-o') + 1];
    expect(options).toContain('-k /root/sock');
    expect(options).toContain("-c listen_addresses=''");
  });

  it('passes every server setting through', () => {
    const options = args[args.indexOf('-o') + 1];
    for (const setting of SERVER_SETTINGS) expect(options).toContain(`-c ${setting}`);
  });

  it('allows more connections than the workers and their admin connections need', () => {
    const maxConnections = SERVER_SETTINGS.find((s) => s.startsWith('max_connections='));
    expect(Number(maxConnections?.split('=')[1])).toBeGreaterThan(20);
  });
});

describe('setUpSharedPostgres', () => {
  it('uses an explicit URL verbatim and still namespaces the run', async () => {
    // This is the CI shape: the URL points at the throwaway container from
    // .github/actions/postgres, and this file must not go looking for a local
    // cluster instead.
    const shared = await setUpSharedPostgres({
      VERITY_TEST_SHARED_POSTGRES_URL: 'postgres://verity@gateway:5432/postgres',
    });
    expect(shared?.adminUrl).toBe('postgres://verity@gateway:5432/postgres');
    expect(shared?.namespace).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps a namespace it was given instead of minting over it', async () => {
    // testing.ts documents VERITY_TEST_DB_NAMESPACE as an input. Pinning one —
    // to reuse a database, or to aim two processes at the same set — has to
    // survive this function, or the documentation describes a variable nothing
    // reads.
    const shared = await setUpSharedPostgres({
      VERITY_TEST_SHARED_POSTGRES_URL: 'postgres://verity@gateway:5432/postgres',
      VERITY_TEST_DB_NAMESPACE: 'pinned',
    });
    expect(shared?.namespace).toBe('pinned');
  });

  it('leaves the suite on pglite when the local cluster is opted out', async () => {
    expect(await setUpSharedPostgres({ VERITY_TEST_LOCAL_POSTGRES: '0' })).toBeUndefined();
  });

  it('treats an empty URL as unset rather than connecting to it', async () => {
    // A CI step that exports the variable from an unset one produces '', and
    // passing that to pg fails with a parse error a long way from here.
    expect(
      await setUpSharedPostgres({
        VERITY_TEST_SHARED_POSTGRES_URL: '',
        VERITY_TEST_LOCAL_POSTGRES: '0',
      }),
    ).toBeUndefined();
  });

  it('stays on pglite silently when nothing is installed', async () => {
    const warnings: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'verity-test-postgres-'));
    try {
      expect(
        await setUpSharedPostgres(
          { VERITY_TEST_POSTGRES_ROOT: root },
          (m) => warnings.push(m),
          () => undefined,
        ),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Silently: this is the laptop case, not a fault, and a warning per run
    // would train everyone to ignore the one that means something.
    expect(warnings).toEqual([]);
  });

  // Debian and Ubuntu install the server at exactly the path findServerBinDir
  // globs, so a developer machine can pass the binary check and then have nowhere
  // to write — creating a directory under /var/lib is not this suite's business.
  // Without the gate those hosts get the fallback warning on every run, the noise
  // the case above exists to avoid. Deliberately NOT injecting a binary locator:
  // the gate has to come first, or the machines it protects are the ones that get
  // past it. Skipped where the root exists, which is the sandbox this feature is
  // for — the gate cannot fire there, and asserting anyway would only pin that
  // container's provisioning.
  it.skipIf(existsSync(CLUSTER_ROOT))(
    'stays on pglite silently when the image never created the cluster root',
    async () => {
      const warnings: string[] = [];
      expect(await setUpSharedPostgres({}, (m) => warnings.push(m))).toBeUndefined();
      expect(warnings).toEqual([]);
    },
  );

  it('falls back to pglite with a warning when the cluster will not start', async () => {
    const warnings: string[] = [];
    // A real, writable root — so the failure comes from the step under test and
    // not from the fixture. The binaries are then claimed to be somewhere they
    // are not, which is what a container running this suite can offer: it has no
    // server to break. The point is that the failure is caught and reported
    // rather than thrown — the module promises a broken cluster costs speed, not
    // a red suite.
    const root = mkdtempSync(join(tmpdir(), 'verity-test-postgres-'));
    try {
      const shared = await setUpSharedPostgres(
        { VERITY_TEST_POSTGRES_ROOT: root },
        (message) => warnings.push(message),
        () => '/nonexistent/postgres/bin',
      );
      expect(shared).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('falling back to pglite');
  });

  it('never deletes a data directory under a root it was pointed at', async () => {
    // The re-initialize path is `rm -rf` on a directory, decided from a
    // PG_VERSION file. That is the right trade for the image's own CLUSTER_ROOT,
    // which the Dockerfile creates and nothing else writes to. It is not a trade
    // to make on an arbitrary path someone exported, so a foreign major there
    // has to cost a fallback rather than the directory.
    const root = mkdtempSync(join(tmpdir(), 'verity-test-postgres-'));
    const dataDir = clusterLayout(root).dataDir;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'PG_VERSION'), '15\n');
    try {
      const shared = await setUpSharedPostgres(
        { VERITY_TEST_POSTGRES_ROOT: root },
        () => {},
        // A major the fixture is definitely not, so isForeignMajor answers true
        // and only the gate can keep the directory.
        () => '/nonexistent/99/bin',
      );
      expect(shared).toBeUndefined();
      expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['/tmp/verity test postgres', '/tmp/$(id)', '/tmp/a;rm -rf x', '/tmp/a`id`'])(
    'refuses the cluster root %s',
    async (root) => {
      // `pg_ctl` composes its `-o` payload into a command string and hands it to
      // a shell, so a root is not merely whitespace-split there — it is a place
      // to put an expansion that runs as this user. Refused before anything
      // starts rather than debugged from a socket that never appears.
      const warnings: string[] = [];
      const shared = await setUpSharedPostgres(
        { VERITY_TEST_POSTGRES_ROOT: root },
        (message) => warnings.push(message),
        () => '/nonexistent/postgres/bin',
      );
      expect(shared).toBeUndefined();
      expect(warnings[0]).toContain('unusable cluster root');
    },
  );

  it.each(['/var/folders/9x/T+j~k/T/verity', '/home/dev/.cache/verity-test-pg'])(
    'accepts the cluster root %s',
    async (root) => {
      // The whitelist is the kind of guard that is easy to draw too tight and
      // never notice, because refusing a legitimate root looks exactly like
      // having no server: the suite goes quiet and slow. macOS `$TMPDIR` lives
      // under `/var/folders/<hash>/T/` and that hash carries `+` and `~`, so
      // without them every scratch cluster on a laptop is refused while CI
      // stays green. Asserted through the warning it must NOT produce — these
      // still fall back, on the binaries, which is the next check along, and
      // reporting none is what keeps this test from touching the disk.
      const warnings: string[] = [];
      const shared = await setUpSharedPostgres(
        { VERITY_TEST_POSTGRES_ROOT: root },
        (message) => warnings.push(message),
        () => undefined,
      );
      expect(shared).toBeUndefined();
      expect(warnings.join('\n')).not.toContain('unusable cluster root');
    },
  );
});

/**
 * The two halves of this feature live in different languages and are exercised
 * at different times: the constants above are read by a suite that runs in every
 * container, while the Dockerfile that satisfies them is built by
 * `verity-sandbox.yml` only when one of a handful of paths changes. So a rename
 * on this side would not fail anything until someone provisioned a sandbox and
 * watched it quietly fall back to pglite — the failure mode this module is
 * deliberately forgiving about, and therefore the one worth pinning here.
 *
 * These assert only the coupling. Whether the image ACTUALLY produces a server
 * that starts is a container question, answered by that workflow.
 */
describe('the repo devcontainer and this module agree', () => {
  // Resolved from this file rather than from the cwd: these run in the describe
  // body, at collection time, so a run started anywhere but the repo root would
  // fail the whole file with ENOENT instead of failing one assertion.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
  const dockerfile = read('.devcontainer/Dockerfile');

  it('creates the cluster root the harness writes to, owned by the agent user', () => {
    expect(dockerfile).toContain(`install -d -o dev -g dev -m 0700 ${CLUSTER_ROOT}`);
  });

  it('installs a server whose binaries land where the harness looks for them', () => {
    // Debian puts them under <libdir>/<major>/bin, which is what findServerBinDir
    // globs; the smoke test asserts the version-suffixed directory really exists.
    expect(dockerfile).toContain(`${POSTGRES_LIB_DIR}/\${POSTGRES_MAJOR}/bin`);
    expect(dockerfile).toMatch(/apt-get install .*"postgresql-\$\{POSTGRES_MAJOR\}"/u);
  });

  it('hands the container to the user the cluster root is owned by', () => {
    // Three files have to agree on one name: the Dockerfile creates
    // CLUSTER_ROOT owned by `dev` and ends on `USER dev`, devcontainer.json
    // names the same user, and the harness runs as whoever that is with no
    // sudo to fix it. A mismatch is not a slow suite — it is a permission
    // denied on the socket directory, or an agent handed a root container.
    // Matched as text because the file is JSONC; that it PARSES, and that the
    // provisioner accepts every key in it, is asserted in provisioner.test.ts
    // through the production gate.
    const devcontainer = read('.devcontainer/devcontainer.json');
    expect(devcontainer).toMatch(/"remoteUser":\s*"dev"/u);
    expect(devcontainer).toMatch(/"dockerfile":\s*"Dockerfile"/u);
    expect(dockerfile.trimEnd().endsWith('USER dev')).toBe(true);
  });

  it('tracks the fleet sandbox image rather than pinning its own base', () => {
    // Both halves are read from main.ts, repository AND channel tag. Hard-coding
    // `:latest` here would leave the tag free to move in one place only: this
    // repo would quietly build on a channel the rest of the fleet had left, and
    // an assertion naming the constant would be the thing that said otherwise.
    // A digest pin in the Dockerfile fails this for the same reason.
    const main = read('packages/server/src/main.ts');
    const repo = /const SANDBOX_IMAGE_REPO = '([^']+)'/u.exec(main)?.[1];
    const tag = /const DEFAULT_SANDBOX_IMAGE_TAG = `\$\{SANDBOX_IMAGE_REPO\}:([^`]+)`/u.exec(
      main,
    )?.[1];
    expect(repo).toBeDefined();
    expect(tag).toBeDefined();
    expect(dockerfile).toContain(`ARG VERITY_SANDBOX_IMAGE=${repo ?? ''}:${tag ?? ''}`);
  });
});

describe('the environment the cluster binaries run in', () => {
  it('pins the port the socket file is named after', () => {
    // No TCP listener is opened, but the number still names
    // `<socketDir>/.s.PGSQL.<port>`, and the postmaster reads it from PGPORT
    // when nothing pins it. `socketUrl` emits no port, so libpq would look for
    // 5432 while the server listened elsewhere — and the run would degrade to
    // pglite for anyone who happened to export that variable.
    expect(SERVER_SETTINGS).toContain('port=5432');
    expect(socketUrl('/sock', 'dev')).not.toContain('port');
  });

  it('keeps libpq variables out of the child processes', () => {
    // Same failure from the other side: PGHOST or PGDATA in the ambient shell
    // aims initdb, pg_ctl and psql at a server this module did not start.
    // Everything the cluster needs is on the command line, so dropping them
    // costs nothing.
    const scrubbed = scrubbedEnv({ PATH: '/usr/bin', PGPORT: '5433', PGHOST: '/elsewhere' });
    expect(scrubbed).toEqual({ PATH: '/usr/bin' });
  });
});

describe('the wiring that makes any of this run', () => {
  it('still installs the global setup that hands the workers a server', () => {
    // Deleting that one line disables the whole feature silently: every worker
    // finds no VERITY_TEST_SHARED_POSTGRES_URL, boots its own pglite, and the
    // suite stays green at the wall-clock and memory this branch exists to
    // remove.
    //
    // Read as text, not imported. `vitest.config.ts` drags vite's type surface
    // in behind it, and an import here would drag that surface into
    // `scripts/tsconfig.json` — the project the type-aware lint rules resolve
    // every `scripts/**/*.mjs` against. There it displaces the fetch types
    // `@types/node` supplies, `response.json()` becomes `any`, and four
    // no-unsafe-* errors appear in maintenance scripts this branch never
    // touched. The same reason `.devcontainer` is matched as text above.
    // Anchored on the option name so the path has to be IN `globalSetup`, not
    // merely somewhere in the file.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/globalSetup:\s*\[[^\]]*'\.\/scripts\/vitest-global-setup\.ts'/u);
  });
});
