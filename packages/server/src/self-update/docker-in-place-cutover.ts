import type { DockerClient } from '../docker.js';
import { advanceManagedDeploymentImage, readManagedDeployment } from './managed-deployment.js';
import { MANAGED_DEPLOYMENT_LABEL, MANAGED_ROLE_LABEL } from './managed-server-owner.js';
import {
  DEFAULT_READINESS_PROBE_URL,
  READINESS_PROBE_TIMEOUT_ENV,
  READINESS_PROBE_URL_ENV,
  parseReadinessProbeUrl,
} from './readiness-probe.js';
import {
  drainManagedGateway,
  enterManagedGatewayMaintenance,
  leaveManagedGatewayMaintenance,
  MANAGED_GATEWAY_CONTROL_SOCKET,
  readManagedGatewayStatus,
  switchManagedGatewayBackend,
} from './managed-gateway-control.js';
import {
  createUpdateJournalCutoverStore,
  type CutoverState,
  type UpdateCutoverDeps,
} from './update-cutover.js';
import { readUpdateJournal } from './update-journal.js';
import { openActivationGate } from './activation-gate.js';
import { generationOperationId } from './docker-update-preparation.js';
import {
  readBundledPostgresImage,
  reconcileControlPlanePostgres,
  type PostgresReconcileOutcome,
} from './postgres-image.js';
import type { StandbyDirective, StandbyExchange } from './standby-directive.js';

/**
 * Generation-qualified standby promotion (ADR 0008 D7/D9/D12).
 *
 * Preparation starts the exact target container under `-g<n>`. Its process
 * waits for a root-owned journal gate and then behind PostgreSQL's activation
 * lock while the old generation serves.
 * Cutover drains the Gateway, asks the old Server to quiesce, promotes that
 * same candidate, switches routing durably, and retains the old container
 * through the observation window for forward-fenced rollback.
 *
 * Quiescing is a request, not a stop. The old Server gives up the generation,
 * the pools, and the listeners, and stays alive holding its unlocked key — so
 * the maintenance window closes on a process a rollback can hand traffic back
 * to, rather than on a container that has to boot first, and the key handed
 * over for D8 has an owner for as long as the update might still need it.
 *
 * The stop remains as the fallback, and it is not only there for failures: a
 * Server from an image that predates the directive never answers one, so an
 * update FROM such a version quiesces it the only way it understands. Every
 * property below therefore has to hold both ways.
 */

const UPDATE_ID_LABEL = 'verity.update-id';
const GENERATION_LABEL = 'verity.generation';
const PROBE_ROLE_PREFIX = 'probe-';

export class CandidateReadinessError extends Error {
  readonly diagnostics: string;
  constructor(message: string, diagnostics: string) {
    super(message);
    this.name = 'CandidateReadinessError';
    this.diagnostics = diagnostics;
  }
}

export type StandbyPromotionDocker = Pick<
  DockerClient,
  | 'containerLogs'
  | 'createContainer'
  | 'imageExists'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'inspectImageLabels'
  | 'listContainers'
  | 'pullImage'
  | 'removeContainer'
  | 'replaceContainerImage'
  | 'startContainer'
  | 'stopContainer'
  | 'waitContainer'
>;

export interface DockerStandbyPromotionOptions {
  /** Updater-owned root holding both the sealed spec and the update journal. */
  readonly managedRoot: string;
  readonly docker: StandbyPromotionDocker;
  /** Environment the sealed `env:` sources resolve against (the Updater's own). */
  readonly environment?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => Promise<string>;
  /** Health endpoint the probe container polls. */
  readonly probeUrl?: string;
  /**
   * Endpoint and budget used only to prove the retained Server on rollback.
   *
   * Both default to the candidate's. A caller that deliberately points the
   * candidate probe at something unserved to force a rollback — the live smoke
   * does exactly that — must not poison the proof that the old generation came
   * back, nor hold the safety path to the shortened budget it chose to bound
   * the forward path's deliberate failure.
   */
  readonly rollbackProbe?: {
    readonly url?: string;
    readonly readinessTimeoutMs?: number;
  };
  /**
   * The standby exchange with the outgoing Server (ADR 0008 D9), shared with
   * the control boundary that publishes one side of it and collects the other.
   *
   * Absent — a caller that runs a cutover without a control boundary — every
   * quiesce is a container stop, which is what this phase did before standbys
   * existed and is still what an old Server image gets.
   */
  readonly standby?: StandbyExchange;
  /**
   * How long the old Server may take to answer a directive before the cutover
   * stops its container instead.
   *
   * Bounds a maintenance window, so it is short on purpose: the Server has only
   * to close what it has open and release two locks, and every second past that
   * is a second of downtime bought against a standby that is probably not
   * coming. Both directions use it — waiting for a quiesce that never lands,
   * and waiting on rollback for a Server that will not come back.
   */
  readonly standbyTimeoutMs?: number;
  /** How long the new generation may take to start serving. */
  readonly readinessTimeoutMs?: number;
  /** How much longer than its own budget a probe container may take to finish
   *  before the executor stops waiting for it. */
  readonly probeGraceMs?: number;
  /** How long it must KEEP serving, unattended, before the update commits. */
  readonly observeMs?: number;
  readonly observeTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly gatewayControlSocket?: string;
  readonly gatewayDrainTimeoutMs?: number;
  /** Test seam for the root-owned journal-controlled activation gate. */
  readonly activate?: (operationId: string, peerGid: number) => Promise<void>;
  readonly gateway?: {
    status(): Promise<{ maintenance: boolean; backend: { host: string } }>;
    enterMaintenance(): Promise<void>;
    leaveMaintenance(): Promise<void>;
    drain(timeoutMs: number): Promise<void>;
    switchBackend(host: string): Promise<void>;
  };
  /** Test seam for the control-plane PostgreSQL reconcile (ADR 0008 D14). */
  readonly reconcilePostgres?: (state: CutoverState) => Promise<PostgresReconcileOutcome>;
  /** How long the swapped PostgreSQL may take to answer a query before the swap
   *  is given up on and the previous digest is put back. */
  readonly postgresProofTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

const missing = (error: unknown): boolean =>
  (error as { kind?: unknown }).kind === 'container_not_found';

/**
 * Say what happened to the database, in the Updater's own log.
 *
 * Every branch is written out rather than folded into one line, because these
 * are four different situations for an operator and only one of them is
 * routine. A refusal in particular is the ONLY place a major-version block
 * announces itself during an update, so it says what has to be done about it.
 */
function logPostgresOutcome(
  outcome: PostgresReconcileOutcome,
  log: (message: string) => void,
): void {
  if (outcome.kind === 'not-bundled' || outcome.kind === 'up-to-date') return;
  if (outcome.kind === 'updated') {
    log(`control-plane PostgreSQL updated from ${outcome.from} to ${outcome.to}`);
    return;
  }
  if (outcome.kind === 'rolled-back') {
    log(
      `control-plane PostgreSQL was NOT updated to ${outcome.to} and is back on ` +
        `${outcome.restored}: ${outcome.reason}`,
    );
    return;
  }
  log(`control-plane PostgreSQL was left as it is: ${outcome.reason}`);
}

/** Docker calls that mean "make sure this is gone" — an absent container is the
 *  desired end state, not a failure, which is what makes resume safe. */
async function ignoreMissing(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function findNamed(
  docker: StandbyPromotionDocker,
  name: string,
): Promise<string | undefined> {
  if (docker.listContainers === undefined)
    throw new Error('standby promotion requires container listing');
  const matches = (await docker.listContainers()).filter((item) => item.names?.includes(name));
  if (matches.length > 1) throw new Error(`multiple containers use reserved name: ${name}`);
  return matches[0]?.id;
}

async function nameOfContainer(
  docker: StandbyPromotionDocker,
  id: string,
): Promise<string | undefined> {
  if (docker.listContainers === undefined) throw new Error('cutover requires container listing');
  return (await docker.listContainers()).find((item) => item.id === id)?.names?.[0];
}

/** Deliberately NOT `unref`'d. The observation window can be the only pending
 *  work in the whole process — startup recovery runs before the control
 *  boundary opens — and an unreferenced timer would let Node run the loop dry
 *  and exit mid-cutover. The restart would resume at the same phase and exit
 *  again, so the update would never commit and never roll back. */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

class ProbeDeadlineError extends Error {}

/**
 * Bound a probe run by the executor's own budget instead of by whatever timeout
 * the Docker transport happens to carry.
 *
 * The probe enforces its budget INSIDE the container, which only helps once the
 * container is running: an image whose entrypoint blocks, or a daemon that never
 * schedules it, leaves the wait pending on an unrelated transport deadline. By
 * that point the old generation is already gone, so how long a cutover waits
 * before it gives up and rolls back has to be a decision this executor makes.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  // The loser of the race stays live. The caller force-removes the probe
  // container on its way out, which makes a pending Docker wait fail; with no
  // handler attached that would surface as an unhandled rejection.
  void work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ProbeDeadlineError());
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function dockerStandbyPromotion(
  options: DockerStandbyPromotionOptions,
): Promise<UpdateCutoverDeps> {
  const docker = options.docker;
  if (
    docker.listContainers === undefined ||
    docker.waitContainer === undefined ||
    docker.containerLogs === undefined
  )
    throw new Error('Docker standby-promotion capabilities are unavailable');
  const deployment = await readManagedDeployment(options.managedRoot);
  if (!deployment.managed)
    throw new Error(`managed Server authority unavailable: ${deployment.reason}`);
  const serverGid = deployment.spec.user.gid;
  const journal = await readUpdateJournal(options.managedRoot);
  if (journal === null) throw new Error('update journal does not exist');
  if (journal.deploymentId !== deployment.spec.deploymentId)
    throw new Error('update journal deployment does not match managed authority');
  const probeUrl = parseReadinessProbeUrl(options.probeUrl ?? DEFAULT_READINESS_PROBE_URL);
  const rollbackProbeUrl = parseReadinessProbeUrl(options.rollbackProbe?.url ?? probeUrl);
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
  const rollbackReadinessTimeoutMs =
    options.rollbackProbe?.readinessTimeoutMs ?? readinessTimeoutMs;
  const probeGraceMs = options.probeGraceMs ?? 30_000;
  const observeMs = options.observeMs ?? 20_000;
  const observeTimeoutMs = options.observeTimeoutMs ?? 30_000;
  const sleep = options.sleep ?? wait;
  const gatewaySocket = options.gatewayControlSocket ?? MANAGED_GATEWAY_CONTROL_SOCKET;
  const gatewayDrainTimeoutMs = options.gatewayDrainTimeoutMs ?? 30_000;
  const standbyTimeoutMs = options.standbyTimeoutMs ?? 15_000;
  const log =
    options.log ??
    ((message: string) => {
      console.log(`[self-update] ${message}`);
    });
  const activate = options.activate ?? openActivationGate;
  const gateway = options.gateway ?? {
    status: () => readManagedGatewayStatus(gatewaySocket),
    enterMaintenance: async () => {
      await enterManagedGatewayMaintenance(gatewaySocket);
    },
    leaveMaintenance: async () => {
      await leaveManagedGatewayMaintenance(gatewaySocket);
    },
    drain: async (timeoutMs: number) => {
      await drainManagedGateway(gatewaySocket, timeoutMs);
    },
    switchBackend: async (host: string) => {
      await switchManagedGatewayBackend(gatewaySocket, {
        host,
        publicPort: 8082,
        internalPort: 8083,
      });
    },
  };
  /**
   * Run the readiness verdict in a throwaway container on the managed network.
   *
   * The Updater is `network_mode: none`, so it cannot make the HTTP call
   * itself; this borrows the target image's own `readiness-probe` entrypoint and
   * reads the verdict off the exit code. The container carries no environment,
   * no mounts, and no capabilities — only the URL and its budget.
   */
  const probe = async (
    state: CutoverState,
    role: string,
    timeoutMs: number,
    host: string,
    image: string,
    baseUrl: string = probeUrl,
  ): Promise<void> => {
    const name = `verity-managed-probe-${role}-g${String(state.candidateGeneration)}`;
    const labels = {
      [MANAGED_DEPLOYMENT_LABEL]: journal.deploymentId,
      [MANAGED_ROLE_LABEL]: `${PROBE_ROLE_PREFIX}${role}`,
      [UPDATE_ID_LABEL]: journal.updateId,
      [GENERATION_LABEL]: String(state.candidateGeneration),
    };
    const stale = await findNamed(docker, name);
    if (stale !== undefined) {
      // A crash can leave a previous attempt's probe behind. Reclaim only our
      // own: a foreign container on this name is a conflict to report, not
      // something to delete.
      const existing = await docker.inspectContainer(stale);
      if (
        existing.labels?.[MANAGED_DEPLOYMENT_LABEL] !== labels[MANAGED_DEPLOYMENT_LABEL] ||
        existing.labels[MANAGED_ROLE_LABEL] !== labels[MANAGED_ROLE_LABEL] ||
        existing.labels[UPDATE_ID_LABEL] !== labels[UPDATE_ID_LABEL]
      )
        throw new Error(`reserved readiness probe name is occupied: ${name}`);
      await ignoreMissing(() => docker.removeContainer(existing.id));
    }
    const created = await docker.createContainer({
      image,
      name,
      labels,
      command: ['readiness-probe'],
      env: [
        `${READINESS_PROBE_URL_ENV}=${(() => {
          const url = new URL(baseUrl);
          url.hostname = host;
          return url.toString();
        })()}`,
        `${READINESS_PROBE_TIMEOUT_ENV}=${String(timeoutMs)}`,
      ],
      user: `${String(deployment.spec.user.uid)}:${String(deployment.spec.user.gid)}`,
      groupAdd: [],
      binds: [],
      volumeMounts: [],
      restartPolicy: 'no',
      network: deployment.spec.network,
      platform: `linux/${deployment.spec.platform.architecture}`,
      readOnlyRootfs: true,
      securityOpt: ['no-new-privileges:true'],
      capAdd: [],
    });
    const deadlineMs = timeoutMs + probeGraceMs;
    try {
      await docker.startContainer(created.id);
      let exitCode: number;
      try {
        exitCode = await withDeadline(docker.waitContainer!(created.id), deadlineMs);
      } catch (error) {
        if (!(error instanceof ProbeDeadlineError)) throw error;
        // Treated as "not ready", not as an infrastructure error: a probe that
        // never returns a verdict has not shown the new generation serving, and
        // the caller must roll back either way.
        throw new CandidateReadinessError(
          `candidate readiness probe (${role}) did not finish within ${String(deadlineMs)}ms`,
          await docker.containerLogs!(created.id, 50).catch(
            () => 'the probe container produced no logs',
          ),
        );
      }
      if (exitCode !== 0)
        throw new CandidateReadinessError(
          `candidate readiness probe (${role}) failed with exit code ${String(exitCode)}`,
          await docker.containerLogs!(created.id, 50),
        );
    } finally {
      await ignoreMissing(() => docker.removeContainer(created.id));
    }
  };

  /**
   * Ask the old Server for a state, and wait until it reports having reached it.
   *
   * The request is recorded rather than sent, because nothing here can send:
   * the Updater has no network, so the old Server is polling its control socket
   * for a directive and this is what that directive is read from. For every
   * phase but one it is redundant — the journal already implies the answer —
   * and it is written anyway so the two never disagree.
   *
   * Resolves `false` on timeout, on an Updater without a place to keep the
   * exchange, and on a Server too old to take part in one — three different
   * reasons for the same conclusion, which is that this cutover has to fall
   * back to acting on the container.
   */
  const awaitStandby = async (state: StandbyDirective): Promise<boolean> => {
    if (options.standby === undefined) return false;
    const operationId = generationOperationId(journal.generation);
    options.standby.request(operationId, state);
    const deadline = Date.now() + standbyTimeoutMs;
    for (;;) {
      if (options.standby.acknowledged(operationId) === state) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
  };

  /**
   * Take back a quiesce this attempt asked for, so traffic can be reopened.
   *
   * Resolves `true` when nothing was asked — there is then no standby to have
   * acted on it, and the container's own state is the whole story — and when a
   * standby confirms it is serving again. Resolves `false` while a Server may
   * still be quiesced, which is the one case in which leaving maintenance would
   * route to a process holding no listeners.
   */
  const withdrawQuiesceRequest = async (): Promise<boolean> => {
    if (options.standby === undefined) return true;
    if (options.standby.requested(generationOperationId(journal.generation)) !== 'quiesced')
      return true;
    return awaitStandby('serving');
  };

  /**
   * Reconcile the control-plane PostgreSQL onto the pin the target release was
   * built against (ADR 0008 D14).
   *
   * The database's own coordinates come from the CANDIDATE container's resolved
   * environment rather than from the sealed spec's env sources: the candidate
   * was created from those sources moments ago, so its `DATABASE_URL` is the
   * same string the Server will connect with, already resolved, and reading it
   * cannot fail for the reasons resolving a sealed source can.
   */
  const reconcilePostgres = async (state: CutoverState): Promise<PostgresReconcileOutcome> => {
    const bundled = await readBundledPostgresImage(docker, journal.targetDigest);
    // Checked before anything else is inspected: a release that names no pin —
    // every release before this decision — must touch nothing at all.
    if (bundled.kind === 'absent') return { kind: 'not-bundled' };
    const candidate = await docker.inspectContainer(state.candidateContainerId);
    const entry = candidate.env?.find((item) => item.startsWith('DATABASE_URL='));
    if (entry === undefined)
      return { kind: 'refused', reason: 'the candidate Server declares no DATABASE_URL' };
    return reconcileControlPlanePostgres({
      docker,
      targetServerImage: journal.targetDigest,
      deploymentId: journal.deploymentId,
      network: deployment.spec.network,
      platform: `linux/${deployment.spec.platform.architecture}`,
      user: `${String(deployment.spec.user.uid)}:${String(deployment.spec.user.gid)}`,
      databaseUrl: entry.slice('DATABASE_URL='.length),
      generation: state.candidateGeneration,
      updateId: journal.updateId,
      ...(options.postgresProofTimeoutMs === undefined
        ? {}
        : { proofTimeoutMs: options.postgresProofTimeoutMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      log,
    });
  };

  // Once the journal has recorded the previous container its own value wins
  // (see `journalState`); resolving it by name only matters for the FIRST
  // transition out of `standby`, while the old container is still the live one.
  const previousContainerId =
    journal.previousContainerId ?? (await findNamed(docker, (await gateway.status()).backend.host));
  if (previousContainerId === undefined)
    throw new Error('standby promotion cannot identify the running managed Server');
  const store = createUpdateJournalCutoverStore(options.managedRoot, previousContainerId);
  const candidateHost = `verity-managed-server-g${String(journal.generation)}`;
  const resolvedOldHost = await nameOfContainer(docker, previousContainerId);
  if (resolvedOldHost === undefined && journal.phase !== 'committed')
    throw new Error('cutover cannot resolve the old Server identity');
  const oldHost = resolvedOldHost ?? 'verity-managed-server';

  return {
    store,

    /**
     * Take the control plane away from the old generation (ADR 0008 D9).
     *
     * Asks first: a Server that follows the directive closes its listeners,
     * releases the generation and the process lock, and stays alive holding its
     * key, which is what the candidate needs and what a rollback returns to.
     * Only a Server that does not answer in time gets stopped — and stopping
     * rather than removing is what makes the pre-activation failure window
     * recoverable either way: rollback's reconcile finds the same container,
     * sees it still matches the still-old sealed spec, and starts it again.
     *
     * The wait is the whole cost of trying: the phase is journalled before it
     * runs, so an Updater that dies inside it resumes here and asks again.
     */
    quiesceOld: async (state) => {
      const wasInMaintenance = (await gateway.status()).maintenance;
      try {
        if (!wasInMaintenance) await gateway.enterMaintenance();
        await gateway.drain(gatewayDrainTimeoutMs);
        if (!(await awaitStandby('quiesced')))
          await ignoreMissing(() => docker.stopContainer(state.oldContainerId));
      } catch (error) {
        const old = await docker.inspectContainer(state.oldContainerId).catch(() => undefined);
        // An earlier attempt may have entered maintenance and crashed before it
        // stopped the old Server. If this attempt also fails, reopen traffic
        // whenever the incumbent is proven able to serve it again.
        //
        // A running container is that proof only while no quiesce was asked for.
        // Once one was, "running" may equally be a standby that closed its
        // listeners and whose acknowledgement arrived after the wait gave up —
        // routing to it would send every request into a process that answers
        // none. So the directive is taken back first, and only a standby that
        // says it serves again reopens the Gateway.
        if (old?.running === true && (await withdrawQuiesceRequest())) {
          try {
            await gateway.leaveMaintenance();
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              'old Server quiesce failed and Gateway service could not be restored',
              { cause: restoreError },
            );
          }
        }
        throw error;
      }
    },

    /**
     * The key handoff (ADR 0008 D8) itself needs nothing from the Updater: it
     * happens between the two Servers, through the mailbox on this Updater's
     * control socket, while the outgoing one is still serving — by the time this
     * phase is reached `quiesceOld` has already stopped the process that holds
     * the key, so there is no one left to ask. The phase survives as the durable
     * marker that the window has closed.
     *
     * WHICH IS EXACTLY WHY the control-plane PostgreSQL is reconciled here
     * (ADR 0008 D14). This is the only point in the deployment's whole life at
     * which the database has no client: `quiesceOld` has just closed the old
     * Server's pools and released its control-plane session, and the candidate
     * is still blocked on the activation gate in `waitForActivationGate`, which
     * it reaches BEFORE it opens any connection. Recreating PostgreSQL under a
     * live Server is what turned a Renovate digest bump into an outage; here
     * there is no live Server for it to happen to. The window is already a
     * maintenance window, so the swap also costs no downtime that is not
     * already being spent — measured at 1.1–1.6s for a graceful recreate of a
     * 1.0 GB `verity-db`, against a phase budget of tens of seconds.
     *
     * Failure to swap is NOT failure to cut over. Every outcome short of a
     * database that cannot be proven to answer leaves PostgreSQL exactly as the
     * Server update found it, and an update has no reason to roll back over a
     * component it did not change.
     */
    handoffKey: async (state) => {
      const outcome = await (options.reconcilePostgres ?? reconcilePostgres)(state);
      logPostgresOutcome(outcome, log);
    },

    /** Advance durable authority and ensure the prepared candidate is running. */
    activateCandidate: async (state) => {
      await advanceManagedDeploymentImage({
        root: options.managedRoot,
        deploymentId: journal.deploymentId,
        fromImage: journal.previousDigest,
        toImage: journal.targetDigest,
      });
      await activate(generationOperationId(journal.generation), serverGid);
      const candidate = await docker.inspectContainer(state.candidateContainerId);
      if (!candidate.running) await docker.startContainer(state.candidateContainerId);
    },

    candidateReady: (state) =>
      probe(state, 'ready', readinessTimeoutMs, candidateHost, journal.targetDigest),

    drainGateway: async () => {
      const status = await gateway.status();
      if (!status.maintenance) await gateway.enterMaintenance();
    },
    switchGatewayToCandidate: async () => {
      const status = await gateway.status();
      if (status.backend.host === candidateHost && !status.maintenance) return;
      if (!status.maintenance) await gateway.enterMaintenance();
      await gateway.switchBackend(candidateHost);
      await gateway.leaveMaintenance();
    },
    switchGatewayToOld: async (state) => {
      const status = await gateway.status();
      if (status.backend.host !== oldHost || status.maintenance) {
        if (!status.maintenance) await gateway.enterMaintenance();
        await gateway.switchBackend(oldHost);
        await gateway.leaveMaintenance();
      }
      await ignoreMissing(() => docker.removeContainer(state.candidateContainerId));
    },

    /** Readiness says it answered once; this says it kept answering. A new
     *  generation that boots and then crashes on its first real work would pass
     *  the first probe and fail this one, which is the point of the phase. */
    observeCandidate: async (state) => {
      await sleep(observeMs);
      await probe(state, 'observe', observeTimeoutMs, candidateHost, journal.targetDigest);
    },
    retireOld: async (state) => {
      await ignoreMissing(() => docker.removeContainer(state.oldContainerId));
    },

    /**
     * Rollback, tearing down the new generation — but only ever the NEW one.
     * The name is checked against the target digest first, because after a
     * failure the container answering to it may already be the old generation
     * (activation never ran, or a previous rollback attempt got this far), and
     * removing that would turn a recoverable update into an outage.
     */
    quiesceCandidate: async (state) => {
      const status = await gateway.status();
      if (!status.maintenance) await gateway.enterMaintenance();
      await gateway.drain(gatewayDrainTimeoutMs);
      const inspect = await docker.inspectContainer(state.candidateContainerId).catch((error) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (inspect === undefined) return;
      if (
        inspect.image !== journal.targetDigest ||
        inspect.labels?.[MANAGED_DEPLOYMENT_LABEL] !== journal.deploymentId
      )
        return;
      await ignoreMissing(() => docker.stopContainer(inspect.id));
    },

    /**
     * Re-seal the previous digest and give the old generation back its role.
     *
     * This is what a standby buys: the phase reads as `serving` again, so a
     * Server that quiesced instead of stopping builds a fresh serving stack
     * under a NEWER generation — no container start, no boot, and its key never
     * left the process. The probe below still has to pass, because "answered a
     * directive" is a weaker claim than "is serving".
     *
     * Everything else falls back to the container: a Server that never answered,
     * one whose resume did not land inside the window, and one that was stopped
     * here to begin with. A running-but-quiesced Server that failed to come back
     * fails the probe and is stopped, which leaves the next attempt the cold
     * start it would have done all along.
     */
    activateOld: async (state) => {
      await advanceManagedDeploymentImage({
        root: options.managedRoot,
        deploymentId: journal.deploymentId,
        fromImage: journal.targetDigest,
        toImage: journal.previousDigest,
      });
      if (!(await awaitStandby('serving'))) {
        const old = await docker.inspectContainer(state.oldContainerId);
        if (!old.running) await docker.startContainer(state.oldContainerId);
      }
      try {
        await probe(
          state,
          'rollback-old',
          rollbackReadinessTimeoutMs,
          oldHost,
          journal.previousDigest,
          rollbackProbeUrl,
        );
      } catch (error) {
        // Suppress `unless-stopped` restart churn while durable rollback remains
        // incomplete. A later recovery attempt starts this exact container again.
        await ignoreMissing(() => docker.stopContainer(state.oldContainerId));
        throw error;
      }
    },
  };
}
