import { stat } from 'node:fs/promises';
import type { ContainerSpec, DockerClient, DockerContainerSummary } from '../docker.js';
import { readManagedDeployment } from './managed-deployment.js';
import { MANAGED_DEPLOYMENT_LABEL, MANAGED_ROLE_LABEL } from './managed-server-owner.js';

export const MANAGED_CONTROL_PLANE_RUNNER_NAME = 'verity-managed-control-plane-runner';
const MANAGED_ROLE = 'control-plane-runner';
export const MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME = 'verity-managed-control-plane-runner-init';
const MANAGED_INIT_ROLE = 'control-plane-runner-init';
/** Matches the companion handoff budget: long enough for a cold image pull to
 *  have already happened, short enough that a wedged daemon call cannot hold
 *  every later reconciliation hostage. */
const PREPARATION_TIMEOUT_MS = 120_000;
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_SERVICE = 'verity-control-runner';
/** The volume whose `supervisor.lock` makes two Runners mutually exclusive. */
const RUNNER_RUNTIME_VOLUME = 'verity-control-runner-runtime';

export type ManagedControlPlaneRunnerDocker = Pick<
  DockerClient,
  | 'createContainer'
  | 'inspectContainer'
  | 'listContainers'
  | 'pullImage'
  | 'removeContainer'
  | 'startContainer'
  | 'stopContainer'
  | 'waitContainer'
>;

export interface ReconcileManagedControlPlaneRunnerOptions {
  readonly managedRoot: string;
  readonly docker: ManagedControlPlaneRunnerDocker;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startupSettlingMs?: number;
  readonly preparationTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injection point for {@link resolveDockerSocket}'s `stat`, so the ADR 0006 Amendment 1
   *  grant is testable without a real daemon socket on the test host. */
  readonly socketGid?: (path: string) => Promise<number>;
}

const missing = (error: unknown): boolean =>
  (error as { kind?: unknown }).kind === 'container_not_found';

async function remove(
  options: ReconcileManagedControlPlaneRunnerOptions,
  id: string,
): Promise<void> {
  try {
    await options.docker.stopContainer(id);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    await options.docker.removeContainer(id);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function create(
  options: ReconcileManagedControlPlaneRunnerOptions,
  desired: ContainerSpec,
): Promise<string> {
  try {
    return (await options.docker.createContainer(desired)).id;
  } catch (error) {
    if (
      (error as { kind?: unknown }).kind !== 'image_not_found' ||
      options.docker.pullImage === undefined
    )
      throw error;
    await options.docker.pullImage(desired.image);
    return (await options.docker.createContainer(desired)).id;
  }
}

/**
 * Compose containers this Runner must displace — and only those.
 *
 * The service label alone is too broad now that reaping runs on every healthy
 * reconcile rather than once at creation: an unrelated Compose project on the
 * same daemon that happens to name a service `verity-control-runner` would be
 * stopped and removed over and over. What actually makes a container a rival is
 * narrower and exact — it holds the same runtime volume, so it contends for the
 * same `supervisor.lock`. Note the volume is declared with an explicit `name:`
 * and is therefore NOT project-prefixed, so a second project running Verity's
 * own Compose files does share it and is a genuine rival; scoping by project
 * name would have missed that one while still catching the innocent bystander.
 */
async function competingLegacy(
  options: ReconcileManagedControlPlaneRunnerOptions,
  summaries: readonly DockerContainerSummary[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const item of summaries) {
    if (item.labels?.[COMPOSE_SERVICE_LABEL] !== COMPOSE_SERVICE) continue;
    // A container that vanished between listing and inspection is already gone,
    // which is the outcome we wanted anyway.
    const inspected = await options.docker.inspectContainer(item.id).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (inspected?.mounts?.some((mount) => mount.name === RUNNER_RUNTIME_VOLUME)) ids.push(item.id);
  }
  return ids;
}

function enabled(
  mounts: readonly { source: { kind: string; name?: string }; target: string }[],
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    (environment.VERITY_CONTROL_PLANE_RUNNER === '1' ||
      environment.VERITY_CONTROL_PLANE_RUNNER === 'true') &&
    mounts.some(
      (mount) =>
        mount.source.kind === 'volume' &&
        mount.source.name === 'verity-control-runner-runtime' &&
        mount.target === '/srv/verity/runners/verity-control',
    )
  );
}

/**
 * The ADR 0006 Amendment 1 kill switch: `VERITY_CONTROL_PLANE_RUNNER_DOCKER`.
 *
 * DEFAULT ON, which is the operator's decision and the reason the polarity is
 * inverted from every other flag in this file. `VERITY_CONTROL_PLANE_RUNNER` and
 * friends are opt-IN and so read `'1' | 'true'`; this one is opt-OUT and reads
 * the same vocabulary negated, rather than inventing a third spelling. Anything
 * else — unset, empty, a typo — leaves the grant on, so a fat-fingered value
 * cannot silently take the operator's diagnostics console away.
 */
function dockerSocketEnabled(environment: NodeJS.ProcessEnv): boolean {
  const flag = environment.VERITY_CONTROL_PLANE_RUNNER_DOCKER?.trim().toLowerCase();
  return flag !== '0' && flag !== 'false';
}

/**
 * Where the daemon socket lives ON THE HOST, and which group owns it.
 *
 * Both are read from what the Server already has rather than from new
 * configuration, because a WRONG answer here is worse than no answer: it
 * produces a socket the agent cannot open, which presents as the feature simply
 * not working and is the failure mode this change exists to end.
 *
 * - The host path comes from the sealed Server deployment spec, which is required
 *   to carry exactly this bind (`deployment-spec.ts` rejects a spec without a
 *   `bind` at `/var/run/docker.sock`). So the Runner is mounted the same socket
 *   the Server was sealed with — it cannot name a different one, and a host that
 *   moves its socket moves both containers together.
 * - The GID comes from `stat`ing that socket through the Server's OWN mount of
 *   it. This is `deploy/bin/verity-compose`'s mechanism (`stat -c '%g'`) applied
 *   from inside the container, and it is authoritative in a way no environment
 *   variable is: it reads the group off the inode the Runner is about to be
 *   handed. `VERITY_DOCKER_SOCKET_GID` is deliberately NOT consulted — the
 *   managed Server resolves its groups from the sealed spec rather than from env,
 *   so that variable need not even be present in this process, and the sealed
 *   `supplementaryGids` list cannot be indexed safely (a deduped set of three
 *   unrelated GIDs, with no marker saying which one is Docker's).
 *
 * Returns `undefined` rather than throwing when the socket cannot be stat'ed: a
 * Runner without Docker is a degraded diagnostics console, while a reconcile that
 * throws is no control plane at all.
 */
async function resolveDockerSocket(
  options: ReconcileManagedControlPlaneRunnerOptions,
  spec: { readonly mounts: readonly { source: { kind: string; path?: string }; target: string }[] },
): Promise<{ hostPath: string; gid: string } | undefined> {
  const mount = spec.mounts.find(
    (entry) => entry.source.kind === 'bind' && entry.target === '/var/run/docker.sock',
  );
  const hostPath = mount?.source.path;
  if (hostPath === undefined) return undefined;
  const gid = await (options.socketGid ?? (async (path) => (await stat(path)).gid))(
    '/var/run/docker.sock',
  ).catch(() => undefined);
  if (gid === undefined || !Number.isInteger(gid) || gid < 1) return undefined;
  return { hostPath, gid: String(gid) };
}

/**
 * Prepare the volumes the Runner needs BEFORE it exists, the way Compose's
 * `verity-control-runner-init` service does for the legacy topology.
 *
 * Without this the managed path can create containers but never state how their
 * volumes must look, so any change to ownership or mode ships only through
 * `verity-install` out of a repository checkout — which is exactly how a release
 * carrying `chmod 2770` reached a host whose identity volume stayed `0770`, and
 * with it a Runner that could never read its own certificate. The Runner itself
 * cannot do this: it mounts the identity volume READ-ONLY on purpose, so that a
 * compromised Runner cannot rewrite the material it authenticates with.
 *
 * Idempotent by construction — every command is a set, not an increment — so it
 * runs on each reconcile rather than being guarded by a state check that could
 * itself go stale.
 */
function prepareSpec(
  image: string,
  deploymentId: string,
  architecture: 'amd64' | 'arm64',
  runtimeGid: string,
): ContainerSpec {
  return {
    image,
    name: MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME,
    labels: {
      [MANAGED_DEPLOYMENT_LABEL]: deploymentId,
      [MANAGED_ROLE_LABEL]: MANAGED_INIT_ROLE,
    },
    entrypoint: ['/bin/sh', '-c'],
    command: [
      [
        'set -eu',
        'mkdir -p /data/workspaces/verity-control /data/sessions',
        'chown -R 1000:1000 /data/workspaces/verity-control',
        `chown 1000:${runtimeGid} /runner`,
        'chmod 0170 /runner',
        `chown 0:${runtimeGid} /identity`,
        // Setgid: the Server publishes identity as an unprivileged user and cannot
        // chown() it to the Runner (an added capability reaches the bounding set
        // only, never permitted/effective for a non-root process). Group
        // inheritance is what hands the material over instead.
        'chmod 2770 /identity',
        // Setgid only governs files created from here on. Material published before
        // the volume had it keeps the wrong group, and the publisher skips rewriting
        // material whose CONTENT is already current — so without this repair the
        // Runner would stay locked out of a certificate that looks perfectly fine.
        // The temporaries are the debris of publishes that failed half-way; nothing
        // ever reads them, and leaving them makes every later listing harder to read.
        `for f in /identity/*; do [ -e "$f" ] || continue; case "$f" in *.tmp) rm -f "$f" ;; *) chown :${runtimeGid} "$f" ;; esac; done`,
      ].join(' && '),
    ],
    user: 'root',
    volumeMounts: [
      { volume: 'verity-data', target: '/data' },
      { volume: 'verity-control-runner-runtime', target: '/runner' },
      { volume: 'verity-control-runner-identity', target: '/identity' },
    ],
    restartPolicy: 'no',
    platform: `linux/${architecture}`,
    securityOpt: ['no-new-privileges:true'],
  };
}

async function prepareVolumes(
  options: ReconcileManagedControlPlaneRunnerOptions,
  spec: ContainerSpec,
): Promise<void> {
  if (options.docker.waitContainer === undefined)
    throw new Error('control-plane Runner volume preparation requires container wait support');
  const summaries = (await options.docker.listContainers?.()) ?? [];
  for (const item of summaries.filter((entry) => entry.names?.includes(spec.name))) {
    // Same ownership rule as the Runner itself: this reconcile removes what it
    // owns and refuses to touch anything else, so a name collision surfaces as an
    // error instead of as somebody else's container quietly disappearing.
    const current = await options.docker.inspectContainer(item.id);
    if (
      current.labels?.[MANAGED_DEPLOYMENT_LABEL] !== spec.labels?.[MANAGED_DEPLOYMENT_LABEL] ||
      current.labels?.[MANAGED_ROLE_LABEL] !== MANAGED_INIT_ROLE
    )
      throw new Error(
        'managed control-plane Runner preparation name is occupied by a foreign container',
      );
    await remove(options, item.id);
  }
  const id = await create(options, spec);
  try {
    await options.docker.startContainer(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      options.docker.waitContainer(id),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(
          () => resolve('timeout'),
          options.preparationTimeoutMs ?? PREPARATION_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (status === 'timeout')
      throw new Error(
        'control-plane Runner volume preparation did not finish in time — the Runner would start against volumes of unknown shape',
      );
    if (status !== 0)
      throw new Error(
        `control-plane Runner volume preparation exited ${String(status)} — the Runner would start against volumes it cannot use`,
      );
  } finally {
    await remove(options, id);
  }
}

/**
 * The Runner's own container spec.
 *
 * EXPORTED for `scripts/verity-compose.test.ts` only: the Compose overlay
 * declares the same container for the pre-managed topology, and the two drifted
 * apart once already (the MCP gateway route, #1570). A test that compares this
 * output against the parsed overlay is what holds them together; a comment is
 * not. (The export and that parity test are lifted from the sibling
 * `feat/control-plane-readonly-workspaces` work, which built the comparison
 * machinery and mutation-checked it in four directions; this change extends it to
 * cover `binds` and Compose's `${VAR:-default}` interpolation, which a
 * named-volume-only mount list never needed.)
 *
 * `dockerSocket` is the ADR 0006 Amendment 1 grant. Absent — because the operator set the
 * kill switch, or because the socket's group could not be read — the returned
 * spec is byte-for-byte what it was before that ADR.
 */
export function desiredSpec(
  image: string,
  deploymentId: string,
  architecture: 'amd64' | 'arm64',
  runtimeGid: string,
  dockerSocket?: { readonly hostPath: string; readonly gid: string },
): ContainerSpec {
  return {
    image,
    name: MANAGED_CONTROL_PLANE_RUNNER_NAME,
    labels: {
      [MANAGED_DEPLOYMENT_LABEL]: deploymentId,
      [MANAGED_ROLE_LABEL]: MANAGED_ROLE,
    },
    entrypoint: ['/usr/bin/tini', '--', '/usr/local/bin/verity-control-plane-runner-start'],
    env: [
      `VERITY_RUNNER_RUNTIME_GID=${runtimeGid}`,
      'VERITY_RUNNER_RUNTIME=/run/verity-runner',
      // The control-plane variant of the gateway route, NOT `/internal/mcp`. This Runner is a
      // fixed peer on the control network with no per-project socket, so its connection
      // carries no project identity and `/internal/mcp` refuses it with 401 — which left
      // every control-plane turn with no brokered tool at all. Keep in lockstep with
      // `deploy/docker-compose.runner-supervisor.yml` and
      // `deploy/bin/verity-control-plane-runner-start`, which spell the same default.
      'VERITY_MCP_GATEWAY_URL=http://verity:8083/internal/control-plane/mcp',
      'VERITY_CLAUDE_EGRESS_URL=https://verity-agent-gateway:9443',
      'VERITY_CLAUDE_EGRESS_SERVERNAME=verity-agent-gateway',
      'VERITY_CODEX_EGRESS_URL=https://verity-agent-gateway:9444',
      'VERITY_CODEX_EGRESS_AUTHORITY=verity-agent-gateway:9444',
      'VERITY_CLAUDE_CONNECTOR_RECONCILE_SECONDS=1',
      // ADR 0006 Amendment 1, told to the launcher as a RESOLVED decision rather than as the
      // operator's raw setting. On this topology the mount is dropped outright
      // when the grant is off, so the launcher's own `-S /var/run/docker.sock`
      // test would already fail closed; stating it anyway keeps the launcher's two
      // inputs identical in both topologies, which is what stops the Compose
      // overlay and this spec from growing separate behaviours.
      `VERITY_CONTROL_PLANE_RUNNER_DOCKER=${dockerSocket === undefined ? '0' : '1'}`,
    ],
    user: 'root',
    // The docker group is granted to the CONTAINER here, but that is not what
    // makes the socket usable — the container's root process could open a 0660
    // root:docker socket without any of it. What matters is the agent child, which
    // `setpriv` drops to uid 1000; the launcher grants it the same group
    // explicitly (`verity-control-plane-runner-start`). This entry keeps the
    // container's own tooling working and mirrors `group_add` in the overlay.
    groupAdd: dockerSocket === undefined ? [runtimeGid] : [runtimeGid, dockerSocket.gid],
    // A BIND, not a `volumeMounts` entry: `ContainerSpec.volumeMounts` resolves
    // its source by named volume, and the daemon socket is a host path. Never
    // read-only — connecting to a Unix socket is a write on the inode, so a
    // read-only mount refuses it even for root.
    ...(dockerSocket === undefined
      ? {}
      : { binds: [`${dockerSocket.hostPath}:/var/run/docker.sock`] }),
    volumeMounts: [
      { volume: 'verity-control-runner-runtime', target: '/run/verity-runner' },
      {
        volume: 'verity-control-runner-identity',
        target: '/run/verity-control-identity',
        readOnly: true,
      },
      { volume: 'verity-data', target: '/work', subpath: 'workspaces/verity-control' },
      { volume: 'verity-data', target: '/srv/verity/sessions', subpath: 'sessions' },
    ],
    restartPolicy: 'unless-stopped',
    network: 'verity-net',
    platform: `linux/${architecture}`,
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP'],
    securityOpt: ['no-new-privileges:true'],
    pidsLimit: 512,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    // Match the ceiling, which disables swap — the Compose service this replaces
    // set `memswap_limit` equal to its `mem_limit` for exactly that reason.
    // Leaving it out would hand the Runner Docker's default of twice the memory
    // limit, so taking ownership would quietly grant 4 GiB of swap that Compose
    // denied. On a host whose swap is already the scarce resource, that trades a
    // clean OOM kill for the box thrashing itself unresponsive.
    memorySwapBytes: 4 * 1024 * 1024 * 1024,
    nanoCpus: 4_000_000_000,
  };
}

/**
 * Keep the dedicated Control Plane Runner on the same sealed image as the
 * managed Server. This deliberately takes ownership away from Compose: a
 * Server self-update cannot rewrite Compose's VERITY_SERVER_IMAGE pin, which
 * otherwise leaves this companion on the pre-update image forever.
 */
export async function reconcileManagedControlPlaneRunner(
  options: ReconcileManagedControlPlaneRunnerOptions,
): Promise<void> {
  if (options.docker.listContainers === undefined)
    throw new Error('control-plane Runner reconciliation requires Docker container listing');
  const deployment = await readManagedDeployment(options.managedRoot);
  if (!deployment.managed)
    throw new Error(`managed Server authority unavailable: ${deployment.reason}`);
  const environment = options.environment ?? process.env;
  if (!enabled(deployment.spec.mounts, environment)) return;
  const runtimeGid = environment.VERITY_RUNNER_RUNTIME_GID?.trim() || '1101';
  if (!/^[1-9][0-9]{0,9}$/.test(runtimeGid))
    throw new Error('VERITY_RUNNER_RUNTIME_GID must be a positive group ID');

  // Before the container that consumes them, and unconditionally: a Runner that is
  // already running against a wrongly-prepared volume is precisely the case an
  // up-to-date check would skip.
  await prepareVolumes(
    options,
    prepareSpec(
      deployment.spec.image,
      deployment.spec.deploymentId,
      deployment.spec.platform.architecture,
      runtimeGid,
    ),
  );

  // Resolved BEFORE the up-to-date check, not only at create time: the check
  // below has to be able to notice that a running Runner disagrees with it.
  const dockerSocket = dockerSocketEnabled(environment)
    ? await resolveDockerSocket(options, deployment.spec)
    : undefined;

  /**
   * Does the RUNNING container already agree with the socket grant?
   *
   * Until now this reconcile recreated on two conditions only — a changed image
   * and a stopped container — so a change touching nothing but the mount list
   * would have been invisible on every host that had already converged. The
   * Runner would keep running, correct by both tests, and simply never acquire
   * the socket: no error, no log line, and no way for the operator to tell "not
   * deployed yet" from "deployed and broken". Turning the grant OFF would be
   * worse — the kill switch would report success while the socket stayed
   * mounted, which is a kill switch that does not kill.
   *
   * Deliberately NOT a general mount differ. Docker echoes mounts back
   * normalized, and a VOLUME in particular gains a resolved `Source` under
   * /var/lib/docker that matches nothing in the spec, so comparing the whole
   * list would find a difference on every pass and recreate the Runner forever —
   * killing the live control-plane session each time. This looks at one mount,
   * and that mount is a BIND, whose `source` the daemon reports back as the host
   * path it was given. `managed-server-owner.ts` already leans on exactly that
   * distinction: `name` for volumes, because their source is unstable, `source`
   * for binds, because it is not.
   *
   * Which is why the source is compared and not the destination alone. A stale
   * bind and a correct one both have destination `/var/run/docker.sock`, so
   * destination alone cannot see a host that MOVED its socket: the sealed spec
   * would say `/run/docker.sock`, the running Runner would still carry the old
   * host path, and reconcile would call that converged forever. The container is
   * then bound to a path that no longer exists — a socket the agent cannot open,
   * which is the "deployed and broken, indistinguishable from not deployed"
   * failure this whole change exists to end.
   *
   * The GID is compared for the same reason, and it is a SEPARATE fact from the
   * path: a host can keep its socket where it is and still renumber the group
   * that owns it (a Docker reinstall does exactly that). The launcher reads the
   * GID off the inode when the container STARTS, so a Runner that keeps running
   * across the change holds the old number for the rest of its life and hands
   * `--groups=<stale>` to every agent it spawns — EACCES on the socket, which
   * reads as a broken daemon. Membership rather than list equality: what has to
   * hold is that the resolved group is present, and pinning the whole list would
   * churn on the runtime GID's spelling without protecting anything more.
   */
  function socketMatches(current: {
    mounts?:
      readonly { destination?: string | undefined; source?: string | undefined }[] | undefined;
    groupAdd?: readonly string[] | undefined;
  }): boolean {
    const socket = current.mounts?.find((mount) => mount.destination === '/var/run/docker.sock');
    if (dockerSocket === undefined) return socket === undefined;
    return (
      socket?.source === dockerSocket.hostPath &&
      current.groupAdd?.includes(dockerSocket.gid) === true
    );
  }

  const summaries = await options.docker.listContainers();
  const legacy = await competingLegacy(options, summaries);
  const named = summaries.filter((item) => item.names?.includes(MANAGED_CONTROL_PLANE_RUNNER_NAME));
  if (named.length > 1)
    throw new Error('multiple containers use the managed control-plane Runner name');
  if (named.length === 1) {
    const current = await options.docker.inspectContainer(named[0]!.id);
    if (
      current.labels?.[MANAGED_DEPLOYMENT_LABEL] !== deployment.spec.deploymentId ||
      current.labels?.[MANAGED_ROLE_LABEL] !== MANAGED_ROLE
    )
      throw new Error('managed control-plane Runner name is occupied by a foreign container');
    if (current.image === deployment.spec.image && current.running && socketMatches(current)) {
      // Reap here too, not only on the create path below. The supervisor lock is
      // exclusive across containers, so a Compose Runner standing beside a
      // healthy managed one cannot start at all — it crash-loops on "runner
      // supervisor is already claimed" for as long as it exists. Leaving that to
      // the create path meant a host that had already converged never cleaned it
      // up, while Compose recreated it on every converge: observed on the
      // dev-server at 91 restarts and climbing. No handover dance is needed on
      // this branch — the managed Runner already holds the lock, so the Compose
      // container owns nothing to hand over.
      for (const id of legacy) await remove(options, id);
      return;
    }
    await remove(options, current.id);
  }

  const desired = desiredSpec(
    deployment.spec.image,
    deployment.spec.deploymentId,
    deployment.spec.platform.architecture,
    runtimeGid,
    dockerSocket,
  );
  const createdId = await create(options, desired);

  // A created container owns no socket yet. Keep the old process recoverable
  // until its replacement has survived startup; only one may run at a time.
  for (const id of legacy) {
    try {
      await options.docker.stopContainer(id);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  try {
    await options.docker.startContainer(createdId);
    await proveStarted(options, createdId);
  } catch (error) {
    await remove(options, createdId);
    const restoreErrors: unknown[] = [];
    for (const id of legacy) {
      try {
        await options.docker.startContainer(id);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length > 0)
      throw new AggregateError(
        [error, ...restoreErrors],
        'managed control-plane Runner failed and its predecessor could not be restored',
        { cause: error },
      );
    throw error;
  }
  for (const id of legacy) {
    await remove(options, id);
  }
}

async function proveStarted(
  options: ReconcileManagedControlPlaneRunnerOptions,
  containerId: string,
): Promise<void> {
  const settlingMs = options.startupSettlingMs ?? 1_000;
  await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(settlingMs);
  const inspect = await options.docker.inspectContainer(containerId);
  if (!inspect.running) {
    throw new Error(
      `managed control-plane Runner exited during startup (${inspect.status ?? 'unknown status'})`,
    );
  }
}
