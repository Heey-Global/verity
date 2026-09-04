import { CONTROL_PLANE_RECONNECT_BUDGET_MS } from '@verity/store';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { MANAGED_DEPLOYMENT_LABEL, MANAGED_ROLE_LABEL } from './managed-server-owner.js';

/**
 * Keeping the control-plane PostgreSQL image current (ADR 0008 D14).
 *
 * Every other managed container is reconciled to the Server digest the journal
 * names, because every other managed container IS the Server image. PostgreSQL
 * is third-party and carries its own pin, so it fell outside that mechanism
 * entirely: on a stock host the digest the first `managed-up` pulled is the
 * digest that host runs forever, and the Renovate bumps that land on the pin in
 * `deploy/docker-compose.yml` reach a host exactly once, at bootstrap. That is
 * an installation with no security updates for its database.
 *
 * Two things are deliberately NOT one thing here:
 *
 * - A DIGEST BUMP INSIDE A MAJOR (18.a → 18.b) swaps binaries over an untouched
 *   `PGDATA`. That is PostgreSQL's own documented contract for a minor release,
 *   it needs no backup, and putting the old digest back is a genuine rollback
 *   because nothing on disk changed. This module does that, unattended.
 * - A MAJOR UPGRADE (18 → 19) rewrites the cluster: the new server refuses to
 *   start on the old `PGDATA` at all, recovery is a restore from backup rather
 *   than a digest, and a backup is a hard prerequisite. This module REFUSES it,
 *   says so, and leaves it to the operator. Verity has no backup facility to
 *   build that on yet, and inventing one inside a cutover window is the wrong
 *   place for it.
 *
 * The CVE exposure everybody actually cares about lives entirely in the first
 * column, which is also the one that is safe to automate.
 */

/**
 * The PostgreSQL image a Server release was built against.
 *
 * An OCI LABEL rather than an environment variable, and that is not a style
 * choice. `managed-server-owner.ts` documents at length why
 * `VERITY_BUNDLED_PROJECT_RELAY_IMAGE` is the ONLY value allowed to reach a
 * managed Server from its image instead of from the sealed spec: every further
 * exemption re-opens the spec/image disagreement that once left the Updater
 * refusing to start its own Server. A label is read off the pulled target image
 * by the Updater and never enters any container's environment, so it adds
 * nothing to that comparison.
 */
export const POSTGRES_IMAGE_LABEL = 'org.verity.postgres-image';

/**
 * `postgres:<tag>@sha256:<digest>` on the official Docker Hub library repo, and
 * nothing else. The tag is retained beside the digest for the same reason the
 * compose pin retains it — a human reading `postgres:18-alpine@sha256:…` can see
 * the major at a glance — but the digest is what is pulled.
 */
const POSTGRES_IMAGE = /^postgres:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/;

/** `PG_MAJOR` as the official image bakes it: the major, and only the major. */
const PG_MAJOR_ENV = 'PG_MAJOR';
const PG_MAJOR = /^([1-9][0-9]{0,2})$/;

/**
 * The major an official pin announces in its own tag.
 *
 * Advisory only, and used only where nothing is about to be changed — the
 * status read below, which has to answer for an image that may never have been
 * pulled and so has no inspectable `PG_MAJOR`. The gate that actually guards a
 * swap does not use this; it compares the running server's `server_version_num`
 * against the target image's baked `PG_MAJOR`, because a tag is a claim and
 * those two are facts.
 */
export function postgresMajorFromRef(ref: string): number | undefined {
  const match = /^postgres:([1-9][0-9]{0,2})(?:[.-]|@)/.exec(ref);
  return match === null ? undefined : Number(match[1]);
}

const PROBE_ROLE = 'postgres-probe';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export type BundledPostgresImage =
  /** The Server image declares no PostgreSQL pin — every release before this one. */
  | { readonly kind: 'absent' }
  /** It declares something that is not an official digest-pinned PostgreSQL ref. */
  | { readonly kind: 'invalid'; readonly value: string }
  | { readonly kind: 'image'; readonly image: string };

/**
 * Read the PostgreSQL pin baked into a Server image.
 *
 * Always the TARGET image, never the running one: the pin travels with the
 * release that carries it, so reading it off the image already in service would
 * only ever reproduce what the host is running.
 */
export async function readBundledPostgresImage(
  docker: Pick<DockerClient, 'inspectImageLabels'>,
  serverImage: string,
): Promise<BundledPostgresImage> {
  if (docker.inspectImageLabels === undefined) return { kind: 'absent' };
  const labels = await docker.inspectImageLabels(serverImage);
  const value = labels?.[POSTGRES_IMAGE_LABEL]?.trim();
  // An empty label is what a PR or local build produces (the build arg defaults
  // empty), and it means the same thing as no label: this image makes no claim.
  if (value === undefined || value === '') return { kind: 'absent' };
  if (!POSTGRES_IMAGE.test(value)) return { kind: 'invalid', value };
  return { kind: 'image', image: value };
}

/** The major an image will RUN, read from the binaries' own build-time stamp. */
export async function postgresImageMajor(
  docker: Pick<DockerClient, 'inspectImageEnv'>,
  image: string,
): Promise<number | undefined> {
  if (docker.inspectImageEnv === undefined) return undefined;
  const environment = await docker.inspectImageEnv(image);
  const entry = environment?.find((item) => item.startsWith(`${PG_MAJOR_ENV}=`));
  const value = entry?.slice(PG_MAJOR_ENV.length + 1);
  if (value === undefined || !PG_MAJOR.test(value)) return undefined;
  return Number(value);
}

/**
 * The major a live server reports, from `server_version_num`.
 *
 * `180006` is 18.6. PostgreSQL has encoded the major in the leading digits since
 * 10; nothing Verity can run predates that.
 */
export function majorOfServerVersionNum(serverVersionNum: number): number | undefined {
  if (!Number.isSafeInteger(serverVersionNum) || serverVersionNum < 100000) return undefined;
  return Math.floor(serverVersionNum / 10000);
}

export interface ControlPlaneDatabaseAddress {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly database: string;
  /**
   * Carried, not discarded.
   *
   * Verity's own compose file gives PostgreSQL `trust` auth on an unpublished
   * network and therefore has no password at all — but the deployment supplies
   * the connection string, and one that carries a password would otherwise make
   * every probe fail authentication and the reconcile permanently impossible on
   * that host, silently and for a reason nothing reports.
   */
  readonly password?: string;
}

const DNS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
const PG_IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;
const PORT = /^[1-9][0-9]{0,4}$/;

/**
 * Take the database's own coordinates from the connection string the deployment
 * already resolved, rather than re-deriving them.
 *
 * Refuses anything it cannot state exactly. These values become argv for a probe
 * container — there is no shell anywhere on that path, so this is about being
 * sure we are talking to the deployment's own database and not about quoting.
 */
export function parseControlPlaneDatabaseUrl(
  databaseUrl: string,
): ControlPlaneDatabaseAddress | undefined {
  let url: URL;
  let user: string;
  let database: string;
  let password: string | undefined;
  // `decodeURIComponent` belongs INSIDE this, not only the constructor. `URL`
  // accepts a malformed percent escape happily and leaves it to be decoded
  // later, so `postgres://bad%ZZ@postgres/db` parses and then throws a
  // `URIError` on the way out — from inside a cutover's maintenance window,
  // where an unreadable connection string has to mean "do not touch the
  // database" and not "roll the whole Server update back".
  try {
    url = new URL(databaseUrl);
    user = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    password = url.password === '' ? undefined : decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return undefined;
  const host = url.hostname;
  const port = url.port === '' ? '5432' : url.port;
  if (!DNS_NAME.test(host) || !PORT.test(port)) return undefined;
  if (!PG_IDENTIFIER.test(user) || !PG_IDENTIFIER.test(database)) return undefined;
  return { host, port, user, database, ...(password === undefined ? {} : { password }) };
}

export type PostgresReconcileOutcome =
  /** The target Server release names no PostgreSQL pin, so there is nothing to do. */
  | { readonly kind: 'not-bundled' }
  /** Already on the bundled digest — the ordinary answer on most updates. */
  | { readonly kind: 'up-to-date'; readonly image: string }
  /**
   * Deliberately not attempted. Carries the reason because every one of them is
   * something an operator may have to act on, and a major-version difference is
   * the one that says so outright.
   */
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'updated'; readonly from: string; readonly to: string }
  /** Attempted, not proven, and put back. The volume was never touched. */
  | {
      readonly kind: 'rolled-back';
      readonly to: string;
      readonly restored: string;
      readonly reason: string;
    };

export type PostgresReconcileDocker = Pick<
  DockerClient,
  | 'containerLogs'
  | 'createContainer'
  | 'imageExists'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'inspectImageLabels'
  | 'listContainers'
  | 'removeContainer'
  | 'replaceContainerImage'
  | 'startContainer'
  | 'waitContainer'
>;

export interface ReconcileControlPlanePostgresOptions {
  readonly docker: PostgresReconcileDocker;
  /** The image whose label carries the pin — the digest being cut over TO. */
  readonly targetServerImage: string;
  readonly deploymentId: string;
  readonly network: string;
  readonly platform: 'linux/amd64' | 'linux/arm64';
  /** `<uid>:<gid>` the probe container runs as; the sealed Server principal. */
  readonly user: string;
  /** The Server's own resolved `DATABASE_URL`. */
  readonly databaseUrl: string;
  readonly generation: number;
  readonly updateId: string;
  /**
   * How long the database may take to answer before the proof gives up.
   *
   * Defaults to the Server's OWN tolerance for a silent database
   * ({@link CONTROL_PLANE_RECONNECT_BUDGET_MS}), and that is the point rather
   * than a coincidence. This proof gates a phase whose next step starts a Server
   * that will itself wait exactly that long, so a shorter budget here would fail
   * cutovers over blips the candidate was going to survive — the gate must never
   * be stricter than the thing it is gating for.
   */
  readonly proofTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function ignoreMissing(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if ((error as { kind?: unknown }).kind !== 'container_not_found') throw error;
  }
}

/**
 * Reconcile the control-plane PostgreSQL container onto the digest the target
 * Server release was built against.
 *
 * WHERE this runs is the entire safety argument, so it is stated here as well as
 * at the call site: inside the cutover's existing quiesce window, after the old
 * Server has given up its pools and its control-plane session and before the
 * candidate has claimed anything. In that window no process in the deployment
 * holds a PostgreSQL connection, so the failure mode that made a Postgres
 * restart an outage — a live Server misreading a restarting database and
 * exiting — is not mitigated here, it is unreachable: there is no live Server to
 * misread anything. It also costs no downtime that is not already being spent;
 * the Server is down either way.
 *
 * It NEVER pulls, and neither does anything it calls. The pull belongs to
 * preparation, before the old Server quiesces; an image that is not already on
 * the daemon means the swap is skipped this time rather than a registry
 * round-trip inside a maintenance window. `replaceContainerImage` used to defeat
 * that on its own by pulling unconditionally, so it now skips the pull for a
 * digest-pinned ref the daemon already holds — the guarantee is only worth
 * stating here because it is enforced there.
 *
 * The outcome is returned rather than thrown for everything short of a database
 * that cannot be proven to work. A refusal, and a swap that was tried and put
 * back, are both states in which PostgreSQL is serving — and the Server update
 * that is halfway through this window has no reason to roll back because its
 * database is still exactly what it was.
 */
export async function reconcileControlPlanePostgres(
  options: ReconcileControlPlanePostgresOptions,
): Promise<PostgresReconcileOutcome> {
  const docker = options.docker;
  const log = options.log ?? (() => undefined);
  const bundled = await readBundledPostgresImage(docker, options.targetServerImage);
  if (bundled.kind === 'absent') return { kind: 'not-bundled' };
  if (bundled.kind === 'invalid')
    return {
      kind: 'refused',
      reason: `the target Server image declares an unusable PostgreSQL pin: ${bundled.value}`,
    };
  const target = bundled.image;

  if (
    docker.listContainers === undefined ||
    docker.replaceContainerImage === undefined ||
    docker.waitContainer === undefined ||
    docker.containerLogs === undefined
  )
    return { kind: 'refused', reason: 'the Updater cannot operate containers precisely enough' };

  const address = parseControlPlaneDatabaseUrl(options.databaseUrl);
  if (address === undefined)
    return { kind: 'refused', reason: 'the control-plane database URL cannot be read' };

  const found = await findControlPlanePostgres(docker, address.host, options.network);
  if (found === undefined)
    return {
      kind: 'refused',
      reason: `no single managed PostgreSQL container serves ${address.host} on ${options.network}`,
    };
  const running = found.image;
  if (running === undefined)
    return { kind: 'refused', reason: 'the running PostgreSQL container reports no image' };

  const probe = createPostgresProbe(options, address);

  /**
   * Prove whatever is CURRENTLY serving under the database's name, having looked
   * it up again first.
   *
   * The identity is re-resolved rather than carried, because a
   * `replaceContainerImage` that throws has not necessarily left the predecessor
   * in place: it restores and restarts it for most failures, but a failure in
   * its final cleanup leaves the SUCCESSOR healthy and already renamed to the
   * canonical name. Probing the id we started with would then declare a working
   * database broken and abort a cutover for it.
   */
  const proveCanonical = async (): Promise<{ id: string; image: string }> => {
    const current = await findControlPlanePostgres(docker, address.host, options.network);
    if (current?.image === undefined)
      throw new Error('the control-plane PostgreSQL container could not be identified');
    await probe.proveServing(current.id, current.image);
    return { id: current.id, image: current.image };
  };

  if (running === target) {
    // NOT a shortcut, and the difference matters on a resumed operation. The
    // phase is journalled before it runs, so an Updater that died between a
    // successful swap and its proof comes back here with the target already
    // running, and returning early would activate the candidate against a
    // database this cutover never proved.
    //
    // The failure is allowed to propagate, like every other unprovable
    // database here. There is nothing to roll back TO — `PGDATA` is untouched
    // and this IS the pin the release wants — but "nothing to repair" is not
    // "carry on": the next phase activates a new generation against a database
    // that does not answer, which cannot succeed, and the cutover would only
    // discover that after the full readiness budget, having meanwhile advanced
    // the sealed image and torn down the standby that was the way back. Failing
    // here lands on the retained old Server minutes earlier, holding its key,
    // ready to serve the moment the database returns.
    await proveCanonical();
    return { kind: 'up-to-date', image: running };
  }

  if (docker.imageExists === undefined)
    return {
      kind: 'refused',
      reason: 'the no-network updater cannot verify that the target PostgreSQL image is present',
    };
  if (!(await docker.imageExists(target)))
    return {
      kind: 'refused',
      reason: `${target} was not pulled before the maintenance window opened`,
    };

  // THE GATE. Both sides of it are read from what actually exists: the major the
  // LIVE server reports, and the major the TARGET binaries were built as. A
  // difference means `pg_upgrade` or a dump/restore, which is an operator's
  // decision with a backup behind it, and is refused here in both directions —
  // an accidental downgrade destroys a cluster just as thoroughly as an
  // unprepared upgrade.
  const targetMajor = await postgresImageMajor(docker, target);
  if (targetMajor === undefined)
    return { kind: 'refused', reason: `${target} does not declare its PostgreSQL major version` };
  const serverVersionNum = await probe.serverVersionNum(running);
  if (serverVersionNum === undefined)
    return { kind: 'refused', reason: 'the running PostgreSQL did not report its version' };
  const runningMajor = majorOfServerVersionNum(serverVersionNum);
  if (runningMajor === undefined)
    return {
      kind: 'refused',
      reason: `the running PostgreSQL reported an unusable version ${String(serverVersionNum)}`,
    };
  if (runningMajor !== targetMajor)
    return {
      kind: 'refused',
      reason:
        `operator action required: PostgreSQL ${String(runningMajor)} is running and ` +
        `${target} is major ${String(targetMajor)}. A major change rewrites the cluster and ` +
        'needs a backup and a maintenance workflow, so the Updater will not do it.',
    };

  log(`replacing the control-plane PostgreSQL ${running} with ${target}`);
  let currentId: string;
  try {
    currentId = await docker.replaceContainerImage(found.id, target);
  } catch (error) {
    // Whatever the client left behind has to be proven either way, and its image
    // is what says whether the swap took. Trusting the error to mean "restored"
    // would misreport a successor that is already serving.
    const current = await proveCanonical();
    return current.image === target
      ? { kind: 'updated', from: running, to: target }
      : { kind: 'rolled-back', to: target, restored: current.image, reason: describe(error) };
  }

  try {
    await probe.proveServing(currentId, target);
  } catch (error) {
    // A true rollback, not a recovery: `PGDATA` was never written by a different
    // major, so putting the old digest back restores the exact previous state.
    try {
      await docker.replaceContainerImage(currentId, running);
      await proveCanonical();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'the control-plane PostgreSQL image swap failed and the previous digest could not be restored',
        { cause: restoreError },
      );
    }
    return { kind: 'rolled-back', to: target, restored: running, reason: describe(error) };
  }
  return { kind: 'updated', from: running, to: target };
}

/**
 * The compose service — and therefore the network alias — Verity's own compose
 * file gives the control-plane database. Used only by the status read below,
 * which has nothing about to change and no candidate container to read a
 * resolved `DATABASE_URL` from.
 */
const CONTROL_PLANE_POSTGRES_SERVICE = 'postgres';

export interface ControlPlanePostgresState {
  /** The digest-pinned image the deployment's PostgreSQL is running. */
  readonly running: string | null;
  /** The pin the INSTALLED Server release was built against. */
  readonly bundled: string | null;
  /** `null` whenever either side is unknown, which is not the same as equal. */
  readonly upToDate: boolean | null;
  /**
   * Why the Updater will not close the gap on its own.
   *
   * The only value today is a major-version difference, which needs a backup and
   * a maintenance workflow rather than a digest swap. It is surfaced here rather
   * than only in an update's log because the hosts that most need to know are
   * exactly the ones that are not updating.
   */
  readonly blocked: 'major-version-change' | null;
}

/**
 * What this host's PostgreSQL is, against what its Server release says it should
 * be — answerable at any time, on a host that has never run an update.
 *
 * That last part is the point. The reconcile only ever runs during a cutover, so
 * a deployment that is not being updated would otherwise have no way to learn
 * that its database is behind, which is precisely the situation this whole
 * decision exists to end.
 */
export async function readControlPlanePostgresState(options: {
  readonly docker: Pick<DockerClient, 'inspectContainer' | 'inspectImageLabels' | 'listContainers'>;
  readonly serverImage: string;
  readonly network: string;
  readonly service?: string;
}): Promise<ControlPlanePostgresState> {
  const bundledImage = await readBundledPostgresImage(options.docker, options.serverImage);
  const bundled = bundledImage.kind === 'image' ? bundledImage.image : null;
  const found =
    options.docker.listContainers === undefined
      ? undefined
      : await findControlPlanePostgres(
          options.docker,
          options.service ?? CONTROL_PLANE_POSTGRES_SERVICE,
          options.network,
        );
  const running = found?.image ?? null;
  if (running === null || bundled === null)
    return { running, bundled, upToDate: null, blocked: null };
  const runningMajor = postgresMajorFromRef(running);
  const bundledMajor = postgresMajorFromRef(bundled);
  const blocked =
    runningMajor !== undefined && bundledMajor !== undefined && runningMajor !== bundledMajor
      ? 'major-version-change'
      : null;
  return { running, bundled, upToDate: running === bundled, blocked };
}

/**
 * The one container that is SERVING the database: it answers to the database's
 * DNS name, sits on the deployment's own network, and is running.
 *
 * The first two conditions are what separate deployments — every Verity's
 * database is the compose service `postgres`, and only the network tells two
 * installations on one host apart. The third is what separates a database from
 * its own leftovers, and it is not a refinement: `replaceContainerImage` renames
 * the predecessor and leaves it stopped for as long as the successor is being
 * proven, and inherits its labels onto that successor. For that whole interval —
 * and permanently, if its final cleanup fails — TWO containers carry the compose
 * service label on this network. Counting both would make the lookup ambiguous
 * and refuse, which would abort a Server cutover over a database that is serving
 * perfectly well from the successor.
 */
async function findControlPlanePostgres(
  docker: Pick<DockerClient, 'inspectContainer' | 'listContainers'>,
  service: string,
  network: string,
): Promise<{ id: string; image: string | undefined } | undefined> {
  const summaries = await docker.listContainers!();
  const matches: Array<{ id: string; image: string | undefined }> = [];
  for (const item of summaries) {
    if (item.labels?.[COMPOSE_SERVICE_LABEL] !== service) continue;
    const inspect = await docker.inspectContainer(item.id);
    if (!inspect.running || inspect.networks?.[network] === undefined) continue;
    matches.push({ id: item.id, image: inspect.image });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

interface PostgresProbe {
  /** `show server_version_num` against the live database, or undefined. */
  serverVersionNum(image: string): Promise<number | undefined>;
  /**
   * Accepting connections AND answering a query, within the budget.
   *
   * `pg_isready` — which is all the container healthcheck runs, and all that
   * `replaceContainerImage` waits for — proves a listener, not a database that
   * completed recovery and can serve. Throws when the budget runs out.
   */
  proveServing(containerId: string, image: string): Promise<void>;
}

function createPostgresProbe(
  options: ReconcileControlPlanePostgresOptions,
  address: ControlPlaneDatabaseAddress,
): PostgresProbe {
  const docker = options.docker;
  const sleep = options.sleep ?? wait;
  const proofTimeoutMs = options.proofTimeoutMs ?? CONTROL_PLANE_RECONNECT_BUDGET_MS;

  /**
   * Ask the database one question from a throwaway container.
   *
   * The Updater is `network_mode: none`, so it cannot speak to PostgreSQL
   * itself — the same constraint the readiness probe works around, solved the
   * same way. The image is PostgreSQL's own, so `psql` is already there and is
   * always the matching client major; the container gets one query as argv, no
   * shell, no mounts, no capabilities, and a read-only root filesystem.
   */
  const ask = async (
    image: string,
    role: string,
    query: string,
  ): Promise<{ exitCode: number; output: string }> => {
    const name = `verity-managed-postgres-${role}-g${String(options.generation)}`;
    const labels = {
      [MANAGED_DEPLOYMENT_LABEL]: options.deploymentId,
      [MANAGED_ROLE_LABEL]: PROBE_ROLE,
      'verity.update-id': options.updateId,
      'verity.generation': String(options.generation),
    };
    const summaries = await docker.listContainers!();
    const stale = summaries.filter((item) => item.names?.includes(name));
    if (stale.length > 1) throw new Error(`reserved PostgreSQL probe name is occupied: ${name}`);
    if (stale[0] !== undefined) {
      const existing = await docker.inspectContainer(stale[0].id);
      // Reclaim only a probe this deployment left behind; a foreign container on
      // the name is a conflict to report, never something to delete.
      if (
        existing.labels?.[MANAGED_DEPLOYMENT_LABEL] !== labels[MANAGED_DEPLOYMENT_LABEL] ||
        existing.labels[MANAGED_ROLE_LABEL] !== PROBE_ROLE
      )
        throw new Error(`reserved PostgreSQL probe name is occupied: ${name}`);
      await ignoreMissing(() => docker.removeContainer(existing.id));
    }
    const spec: ContainerSpec = {
      image,
      name,
      labels,
      entrypoint: ['psql'],
      command: [
        '-w',
        '-h',
        address.host,
        '-p',
        address.port,
        '-U',
        address.user,
        '-d',
        address.database,
        '-tAc',
        query,
      ],
      // `PGPASSWORD` rather than a password in the URL, so it never reaches an
      // argv a `ps` can read. The Updater already holds the Docker socket and is
      // host-root-equivalent, and the Server container carries the same secret
      // in its own environment, so this adds no reachable exposure — and the
      // probe container is removed as soon as it has answered.
      env: [
        'PGCONNECT_TIMEOUT=5',
        ...(address.password === undefined ? [] : [`PGPASSWORD=${address.password}`]),
      ],
      user: options.user,
      groupAdd: [],
      binds: [],
      volumeMounts: [],
      restartPolicy: 'no',
      network: options.network,
      platform: options.platform,
      readOnlyRootfs: true,
      securityOpt: ['no-new-privileges:true'],
      capDrop: ['ALL'],
      capAdd: [],
    };
    const created = await docker.createContainer(spec);
    try {
      await docker.startContainer(created.id);
      const exitCode = await docker.waitContainer!(created.id);
      const output = await docker.containerLogs!(created.id, 20).catch(() => '');
      return { exitCode, output };
    } finally {
      await ignoreMissing(() => docker.removeContainer(created.id));
    }
  };

  return {
    serverVersionNum: async (image) => {
      const { exitCode, output } = await ask(image, 'version', 'show server_version_num');
      if (exitCode !== 0) return undefined;
      const match = /([0-9]{5,7})/.exec(output);
      return match === null ? undefined : Number(match[1]);
    },
    proveServing: async (containerId, image) => {
      const deadline = Date.now() + proofTimeoutMs;
      for (;;) {
        const state = await docker.inspectContainer(containerId).catch(() => undefined);
        let last: string;
        if (state?.running !== true) last = 'the PostgreSQL container is not running';
        else {
          const { exitCode, output } = await ask(image, 'proof', 'select 1');
          if (exitCode === 0 && /(^|\D)1(\D|$)/.test(output)) return;
          last = `the PostgreSQL proof exited ${String(exitCode)}: ${output.trim().slice(0, 200)}`;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `the control-plane PostgreSQL did not answer a query within ${String(proofTimeoutMs)}ms: ${last}`,
          );
        await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
      }
    },
  };
}
