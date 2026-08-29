import { CONTROL_PLANE_RECONNECT_BUDGET_MS } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerSpec } from '../docker.js';
import {
  majorOfServerVersionNum,
  parseControlPlaneDatabaseUrl,
  postgresImageMajor,
  postgresMajorFromRef,
  readBundledPostgresImage,
  readControlPlanePostgresState,
  reconcileControlPlanePostgres,
  POSTGRES_IMAGE_LABEL,
  type PostgresReconcileDocker,
} from './postgres-image.js';

const pgSummary = (id: string) => ({
  id,
  names: [`verity-${id}`],
  labels: { 'com.docker.compose.service': 'postgres' },
});

const pgInspect = (id: string, image: string, running = true) => ({
  id,
  running,
  image,
  networks: { [NETWORK]: {} },
});

const digest = (fill: string): string => `postgres:18-alpine@sha256:${fill.repeat(64)}`;
const RUNNING = digest('a');
const TARGET = digest('b');
const SERVER = `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`;
const NETWORK = 'verity-net';
const DATABASE_URL = 'postgres://verity@postgres:5432/verity';

interface Harness {
  docker: PostgresReconcileDocker;
  readonly created: ContainerSpec[];
  readonly replaced: Array<{ id: string; image: string }>;
  /** Image the (single) database container currently reports. */
  image: string;
  /** Proof results, consumed in order; a success once the list runs out. */
  proof: Array<{ exitCode: number; output: string }>;
  /** A proof verdict that never runs out — a database that stays down. */
  proofAlways?: { exitCode: number; output: string };
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const created: ContainerSpec[] = [];
  const replaced: Array<{ id: string; image: string }> = [];
  const state: Harness = {
    created,
    replaced,
    image: RUNNING,
    proof: [],
    docker: undefined as unknown as PostgresReconcileDocker,
    ...overrides,
  };
  let nextProbeId = 0;
  const probeResults = new Map<string, { exitCode: number; output: string }>();
  state.docker = {
    listContainers: vi.fn(async () => [pgSummary('pg-1')]),
    inspectContainer: vi.fn(async (id: string) => {
      if (id.startsWith('probe-')) return { id, running: false };
      return { id, running: true, image: state.image, networks: { [NETWORK]: {} } };
    }),
    inspectImageLabels: vi.fn(async (ref: string) =>
      ref === SERVER ? { [POSTGRES_IMAGE_LABEL]: TARGET } : undefined,
    ),
    inspectImageEnv: vi.fn(async () => ['PG_MAJOR=18', 'PG_VERSION=18.6']),
    imageExists: vi.fn(async () => true),
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      created.push(spec);
      const id = `probe-${String((nextProbeId += 1))}`;
      const query = spec.command?.at(-1);
      probeResults.set(
        id,
        query === 'show server_version_num'
          ? { exitCode: 0, output: '180006\n' }
          : (state.proofAlways ?? state.proof.shift() ?? { exitCode: 0, output: '1\n' }),
      );
      return { id };
    }),
    startContainer: vi.fn(async () => undefined),
    waitContainer: vi.fn(async (id: string) => probeResults.get(id)?.exitCode ?? 0),
    containerLogs: vi.fn(async (id: string) => probeResults.get(id)?.output ?? ''),
    removeContainer: vi.fn(async () => undefined),
    replaceContainerImage: vi.fn(async (id: string, image: string) => {
      replaced.push({ id, image });
      state.image = image;
      return `${id}-r`;
    }),
  } as unknown as PostgresReconcileDocker;
  return state;
}

const reconcile = (h: Harness, extra: Record<string, unknown> = {}) =>
  reconcileControlPlanePostgres({
    docker: h.docker,
    targetServerImage: SERVER,
    deploymentId: 'deployment-1',
    network: NETWORK,
    platform: 'linux/amd64',
    user: '1000:1000',
    databaseUrl: DATABASE_URL,
    generation: 4,
    updateId: 'update-1',
    proofTimeoutMs: 0,
    sleep: async () => undefined,
    ...extra,
  });

describe('the bundled PostgreSQL pin', () => {
  it('is read from the target Server image, never the running one', async () => {
    const inspectImageLabels = vi.fn(async () => ({ [POSTGRES_IMAGE_LABEL]: TARGET }));
    await expect(readBundledPostgresImage({ inspectImageLabels }, SERVER)).resolves.toEqual({
      kind: 'image',
      image: TARGET,
    });
    expect(inspectImageLabels).toHaveBeenCalledWith(SERVER);
    expect(inspectImageLabels).not.toHaveBeenCalledWith(RUNNING);
  });

  it('treats an absent, empty, or whitespace label as no claim at all', async () => {
    for (const labels of [
      undefined,
      {},
      { [POSTGRES_IMAGE_LABEL]: '' },
      { [POSTGRES_IMAGE_LABEL]: '  ' },
    ])
      await expect(
        readBundledPostgresImage({ inspectImageLabels: async () => labels }, SERVER),
      ).resolves.toEqual({ kind: 'absent' });
  });

  it.each([
    ['postgres:18-alpine', 'no digest'],
    [`postgres@sha256:${'a'.repeat(64)}`, 'no tag'],
    [`ghcr.io/evil/postgres:18@sha256:${'a'.repeat(64)}`, 'a foreign repository'],
    [`postgres:18-alpine@sha256:${'a'.repeat(63)}`, 'a short digest'],
    [`postgres:18-alpine@sha512:${'a'.repeat(64)}`, 'a non-sha256 digest'],
  ])('refuses %s (%s)', async (value) => {
    await expect(
      readBundledPostgresImage(
        { inspectImageLabels: async () => ({ [POSTGRES_IMAGE_LABEL]: value }) },
        SERVER,
      ),
    ).resolves.toEqual({ kind: 'invalid', value });
  });
});

describe('major-version arithmetic', () => {
  it('reads the major a live server reports', () => {
    expect(majorOfServerVersionNum(180006)).toBe(18);
    expect(majorOfServerVersionNum(190000)).toBe(19);
  });

  it('refuses a number that cannot be a modern server version', () => {
    for (const value of [0, -1, 90600, 1.5, Number.NaN])
      expect(majorOfServerVersionNum(value)).toBeUndefined();
  });

  it('reads PG_MAJOR off an image and refuses anything else', async () => {
    await expect(
      postgresImageMajor({ inspectImageEnv: async () => ['PG_MAJOR=18'] }, TARGET),
    ).resolves.toBe(18);
    for (const environment of [[], ['PG_MAJOR='], ['PG_MAJOR=18.6'], ['PG_MAJOR=x'], undefined])
      await expect(
        postgresImageMajor({ inspectImageEnv: async () => environment }, TARGET),
      ).resolves.toBeUndefined();
  });

  it('reads the advisory major out of a pin tag', () => {
    expect(postgresMajorFromRef(digest('a'))).toBe(18);
    expect(postgresMajorFromRef(`postgres:19@sha256:${'a'.repeat(64)}`)).toBe(19);
    expect(postgresMajorFromRef(`postgres:19.2-bookworm@sha256:${'a'.repeat(64)}`)).toBe(19);
    expect(postgresMajorFromRef(`postgres:latest@sha256:${'a'.repeat(64)}`)).toBeUndefined();
  });
});

describe('the control-plane database URL', () => {
  it('takes host, port, user and database from the deployment’s own string', () => {
    expect(parseControlPlaneDatabaseUrl(DATABASE_URL)).toEqual({
      host: 'postgres',
      port: '5432',
      user: 'verity',
      database: 'verity',
    });
  });

  it('carries a password when the deployment supplies one, and omits it otherwise', () => {
    expect(parseControlPlaneDatabaseUrl(DATABASE_URL)).not.toHaveProperty('password');
    expect(
      parseControlPlaneDatabaseUrl('postgres://verity:s3cr%40t@postgres/verity'),
    ).toMatchObject({ user: 'verity', password: 's3cr@t' });
  });

  it('defaults the port only when the URL omits it', () => {
    expect(parseControlPlaneDatabaseUrl('postgres://verity@db/verity')?.port).toBe('5432');
    expect(parseControlPlaneDatabaseUrl('postgres://verity@db:6543/verity')?.port).toBe('6543');
  });

  it.each([
    'https://verity@postgres:5432/verity',
    'postgres://verity@postgres:0/verity',
    'postgres://verity@postgres:5432/',
    'postgres://@postgres:5432/verity',
    'postgres://bre eze@postgres:5432/verity',
    'not a url',
    // `URL` accepts these and defers the failure to the decode, so a parser that
    // only guards the constructor throws a URIError out of a cutover window.
    'postgres://bad%ZZ@postgres:5432/verity',
    'postgres://verity@postgres:5432/bad%ZZ',
    'postgres://verity:bad%ZZ@postgres:5432/verity',
  ])('refuses %s', (value) => {
    expect(parseControlPlaneDatabaseUrl(value)).toBeUndefined();
  });
});

describe('reconciling the control-plane PostgreSQL image', () => {
  it('does nothing at all when the target release names no pin', async () => {
    const h = harness();
    h.docker.inspectImageLabels = vi.fn(async () => undefined);
    await expect(reconcile(h)).resolves.toEqual({ kind: 'not-bundled' });
    expect(h.docker.listContainers).not.toHaveBeenCalled();
    expect(h.replaced).toEqual([]);
  });

  it('changes nothing when the running digest is already the bundled one', async () => {
    const h = harness({ image: TARGET });
    await expect(reconcile(h)).resolves.toEqual({ kind: 'up-to-date', image: TARGET });
    expect(h.replaced).toEqual([]);
  });

  /**
   * A resumed operation re-enters this phase with the swap already done, because
   * the phase is journalled before it runs and an Updater can die between the
   * recreate and its proof. Returning early on "the digest already matches"
   * would activate the candidate against a database this cutover never proved,
   * which is the one thing the proof exists to prevent.
   */
  it('still proves a database that is already on the bundled digest', async () => {
    const h = harness({ image: TARGET });
    await reconcile(h);
    expect(h.created.map((spec) => spec.command?.at(-1))).toContain('select 1');
  });

  /**
   * "Nothing to repair" is not "carry on". There is no digest to put back — the
   * volume is untouched and this IS the pin the release wants — but the next
   * phase starts a new generation against a database that does not answer, which
   * cannot succeed. Failing here returns to the retained old Server, still
   * holding its key, instead of discovering it after the full readiness budget
   * with the sealed image already advanced.
   */
  it('aborts the cutover when a database already on the pin cannot be proven', async () => {
    const h = harness({ image: TARGET, proof: [{ exitCode: 2, output: 'no route to host' }] });
    await expect(reconcile(h)).rejects.toThrow(/did not answer a query/);
    expect(h.replaced).toEqual([]);
  });

  it('swaps the digest and proves the database answers a query', async () => {
    const h = harness();
    await expect(reconcile(h)).resolves.toEqual({ kind: 'updated', from: RUNNING, to: TARGET });
    expect(h.replaced).toEqual([{ id: 'pg-1', image: TARGET }]);
    const proof = h.created.at(-1)!;
    expect(proof.command?.at(-1)).toBe('select 1');
    expect(proof.image).toBe(TARGET);
    expect(proof.network).toBe(NETWORK);
    expect(proof.readOnlyRootfs).toBe(true);
    expect(proof.capDrop).toEqual(['ALL']);
    expect(proof.securityOpt).toEqual(['no-new-privileges:true']);
    expect(proof.binds).toEqual([]);
    expect(proof.volumeMounts).toEqual([]);
  });

  it('gives the probe the password rather than putting it on the command line', async () => {
    const h = harness();
    await reconcile(h, { databaseUrl: 'postgres://verity:s3cr%40t@postgres:5432/verity' });
    const probe = h.created[0]!;
    expect(probe.env).toContain('PGPASSWORD=s3cr@t');
    expect(probe.command?.join(' ')).not.toContain('s3cr@t');
  });

  it('sets no PGPASSWORD for the stock trust-authenticated deployment', async () => {
    const h = harness();
    await reconcile(h);
    expect(h.created[0]!.env).toEqual(['PGCONNECT_TIMEOUT=5']);
  });

  it('asks the RUNNING image for the version and the TARGET image for the proof', async () => {
    const h = harness();
    await reconcile(h);
    const version = h.created.find((spec) => spec.command?.at(-1) === 'show server_version_num');
    expect(version?.image).toBe(RUNNING);
    expect(h.created.filter((spec) => spec.command?.at(-1) === 'select 1')[0]?.image).toBe(TARGET);
  });

  it('refuses an upgrade across a major and says so as operator action', async () => {
    const h = harness();
    h.docker.inspectImageEnv = vi.fn(async () => ['PG_MAJOR=19']);
    const outcome = await reconcile(h);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/operator action required/);
    expect(h.replaced).toEqual([]);
  });

  it('refuses a DOWNGRADE across a major just as hard', async () => {
    const h = harness();
    h.docker.inspectImageEnv = vi.fn(async () => ['PG_MAJOR=17']);
    const outcome = await reconcile(h);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/major 17/);
    expect(h.replaced).toEqual([]);
  });

  it('refuses when the running server will not report its version', async () => {
    const h = harness();
    const inner = h.docker.waitContainer!;
    h.docker.waitContainer = vi.fn(async (id: string) => {
      const spec = h.created.at(-1);
      return spec?.command?.at(-1) === 'show server_version_num' ? 1 : inner(id);
    });
    await expect(reconcile(h)).resolves.toEqual({
      kind: 'refused',
      reason: 'the running PostgreSQL did not report its version',
    });
    expect(h.replaced).toEqual([]);
  });

  it('refuses when the target image was never pulled', async () => {
    const h = harness();
    h.docker.imageExists = vi.fn(async () => false);
    const outcome = await reconcile(h);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/was not pulled/);
    expect(h.replaced).toEqual([]);
    // Refused before anything is asked of the database.
    expect(h.created).toEqual([]);
  });

  it('refuses when the deployment has no single matching database container', async () => {
    for (const containers of [[], [pgSummary('pg-1'), pgSummary('pg-2')]]) {
      const h = harness();
      h.docker.listContainers = vi.fn(async () => containers) as never;
      const outcome = await reconcile(h);
      expect(outcome.kind).toBe('refused');
      expect(h.replaced).toEqual([]);
    }
  });

  it('ignores a database container on a different deployment’s network', async () => {
    const h = harness();
    h.docker.inspectContainer = vi.fn(async (id: string) =>
      id.startsWith('probe-')
        ? { id, running: false }
        : { id, running: true, image: RUNNING, networks: { 'someone-elses-net': {} } },
    );
    const outcome = await reconcile(h);
    expect(outcome.kind).toBe('refused');
    expect(h.replaced).toEqual([]);
  });

  it('puts the previous digest back when the swapped database will not answer', async () => {
    const h = harness({ proof: [{ exitCode: 1, output: 'could not connect' }] });
    const outcome = await reconcile(h);
    expect(outcome).toEqual({
      kind: 'rolled-back',
      to: TARGET,
      restored: RUNNING,
      reason: expect.stringContaining('did not answer a query'),
    });
    expect(h.replaced).toEqual([
      { id: 'pg-1', image: TARGET },
      { id: 'pg-1-r', image: RUNNING },
    ]);
    expect(h.image).toBe(RUNNING);
  });

  it('reports a rollback when the swap itself failed and the client restored it', async () => {
    const h = harness();
    h.docker.replaceContainerImage = vi.fn(async () => {
      throw new Error('replacement container did not become healthy');
    });
    const outcome = await reconcile(h);
    expect(outcome).toEqual({
      kind: 'rolled-back',
      to: TARGET,
      restored: RUNNING,
      reason: 'replacement container did not become healthy',
    });
  });

  /**
   * `replaceContainerImage` restores the predecessor for most failures, but not
   * for a failure in its final cleanup: there the SUCCESSOR is already healthy
   * and already carries the canonical name. Assuming the error meant "restored"
   * would probe a container that is gone and abort a cutover over a database
   * that is serving perfectly well.
   */
  it('reads the surviving container rather than assuming the swap was undone', async () => {
    const h = harness();
    h.docker.replaceContainerImage = vi.fn(async (_id: string, image: string) => {
      h.image = image;
      throw new Error('predecessor cleanup failed after the successor took over');
    });
    await expect(reconcile(h)).resolves.toEqual({ kind: 'updated', from: RUNNING, to: TARGET });
  });

  /**
   * The same failure, in the state a real daemon is actually left in.
   * `replaceContainerImage` copies the predecessor's labels onto the successor
   * and leaves the renamed predecessor STOPPED, so for the whole proving window
   * — and permanently, when its final cleanup fails — two containers carry the
   * compose service label on this network. Counting both would make the lookup
   * ambiguous, and the resulting refusal would abort a Server cutover over a
   * database serving perfectly well from the successor.
   */
  it('resolves the running successor beside a stopped predecessor', async () => {
    const h = harness();
    h.docker.replaceContainerImage = vi.fn(async (_id: string, image: string) => {
      h.image = image;
      h.docker.listContainers = vi.fn(async () => [pgSummary('pg-1'), pgSummary('pg-2')]) as never;
      h.docker.inspectContainer = vi.fn(async (id: string) => {
        if (id.startsWith('probe-')) return { id, running: false };
        // The predecessor, renamed and stopped, still labelled as the service.
        if (id === 'pg-1') return pgInspect(id, RUNNING, false);
        return pgInspect(id, image);
      });
      throw new Error('predecessor cleanup failed after the successor took over');
    });
    await expect(reconcile(h)).resolves.toEqual({ kind: 'updated', from: RUNNING, to: TARGET });
  });

  it('refuses while the database container is not running at all', async () => {
    const h = harness();
    h.docker.inspectContainer = vi.fn(async (id: string) =>
      id.startsWith('probe-') ? { id, running: false } : pgInspect(id, RUNNING, false),
    );
    const outcome = await reconcile(h);
    expect(outcome.kind).toBe('refused');
    expect(h.replaced).toEqual([]);
  });

  it('throws when the previous digest cannot be put back', async () => {
    const h = harness({ proof: [{ exitCode: 1, output: 'no' }] });
    const replace = h.docker.replaceContainerImage!;
    h.docker.replaceContainerImage = vi.fn(async (id: string, image: string) => {
      if (image === RUNNING) throw new Error('restore failed');
      return replace(id, image);
    });
    await expect(reconcile(h)).rejects.toThrow(/could not be restored/);
  });

  it('throws when the restored database cannot be proven either', async () => {
    const h = harness({
      proof: [
        { exitCode: 1, output: 'no' },
        { exitCode: 1, output: 'still no' },
      ],
    });
    await expect(reconcile(h)).rejects.toThrow(/could not be restored/);
    expect(h.replaced).toEqual([
      { id: 'pg-1', image: TARGET },
      { id: 'pg-1-r', image: RUNNING },
    ]);
  });

  /**
   * The proof gates a phase whose next step starts a Server that waits exactly
   * `CONTROL_PLANE_RECONNECT_BUDGET_MS` for a silent database. A shorter budget
   * here would abort cutovers over blips the candidate was going to survive, so
   * the two are pinned together rather than merely chosen to look similar.
   */
  it('waits as long for the database as the Server it is gating for', async () => {
    const h = harness({ image: TARGET, proofAlways: { exitCode: 2, output: 'down' } });
    // A fake clock the sleep stub advances, so the loop's own deadline decides
    // when it gives up and the assertion measures the budget rather than a
    // message: the whole point is HOW LONG it waits.
    vi.useFakeTimers();
    try {
      const started = Date.now();
      await expect(
        reconcileControlPlanePostgres({
          docker: h.docker,
          targetServerImage: SERVER,
          deploymentId: 'deployment-1',
          network: NETWORK,
          platform: 'linux/amd64',
          user: '1000:1000',
          databaseUrl: DATABASE_URL,
          generation: 4,
          updateId: 'update-1',
          sleep: async (ms) => {
            vi.setSystemTime(Date.now() + ms);
          },
        }),
      ).rejects.toThrow(/did not answer a query/);
      expect(Date.now() - started).toBe(CONTROL_PLANE_RECONNECT_BUDGET_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never pulls, even when the image is missing', async () => {
    const h = harness();
    const pullImage = vi.fn(async () => undefined);
    (h.docker as { pullImage?: unknown }).pullImage = pullImage;
    await reconcile(h);
    expect(pullImage).not.toHaveBeenCalled();
  });
});

describe('the reported PostgreSQL delta', () => {
  const state = (running: string | undefined, bundled: string | undefined) =>
    readControlPlanePostgresState({
      docker: {
        listContainers: async () => [pgSummary('pg-1')],
        inspectContainer: async (id: string) => ({
          id,
          running: true,
          ...(running === undefined ? {} : { image: running }),
          networks: { [NETWORK]: {} },
        }),
        inspectImageLabels: async () =>
          bundled === undefined ? undefined : { [POSTGRES_IMAGE_LABEL]: bundled },
      } as never,
      serverImage: SERVER,
      network: NETWORK,
    });

  it('shows the two digests and whether they match', async () => {
    await expect(state(RUNNING, TARGET)).resolves.toEqual({
      running: RUNNING,
      bundled: TARGET,
      upToDate: false,
      blocked: null,
    });
    await expect(state(TARGET, TARGET)).resolves.toEqual({
      running: TARGET,
      bundled: TARGET,
      upToDate: true,
      blocked: null,
    });
  });

  it('never claims equality when one side is unknown', async () => {
    await expect(state(RUNNING, undefined)).resolves.toEqual({
      running: RUNNING,
      bundled: null,
      upToDate: null,
      blocked: null,
    });
  });

  it('flags a major-version difference as needing the operator', async () => {
    const nineteen = `postgres:19-alpine@sha256:${'b'.repeat(64)}`;
    await expect(state(RUNNING, nineteen)).resolves.toMatchObject({
      upToDate: false,
      blocked: 'major-version-change',
    });
  });
});
