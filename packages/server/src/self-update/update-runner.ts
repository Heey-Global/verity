import type { DockerClient } from '../docker.js';
import {
  dockerStandbyPromotion,
  type DockerStandbyPromotionOptions,
  type StandbyPromotionDocker,
} from './docker-in-place-cutover.js';
import {
  dockerUpdatePreparation,
  generationOperationId,
  type UpdatePreparationDocker,
} from './docker-update-preparation.js';
import {
  MANAGED_SERVER_NAME,
  reconcileManagedServer,
  specImageEnvironment,
  type ManagedServerReconcileResult,
  type ManagedServerReconcileVerdict,
} from './managed-server-owner.js';
import { resumeUpdateCutover } from './update-cutover.js';
import {
  advanceCompanionReconciliation,
  failUpdate,
  readUpdateJournal,
  withUpdateJournalLease,
  type PreparationPhase,
  type UpdateJournal,
  type UpdatePhase,
} from './update-journal.js';
import { isTerminalOperationState, projectUpdateOperation } from './update-operation.js';
import { resumeUpdatePreparation } from './update-preparation.js';
import { openActivationGate } from './activation-gate.js';
import {
  MANAGED_GATEWAY_CONTROL_SOCKET,
  waitForManagedGatewayStatus,
} from './managed-gateway-control.js';
import { readManagedDeployment } from './managed-deployment.js';
import { reconcileManagedControlPlaneRunner } from './managed-control-plane-runner.js';
import { reconcileManagedCompanions } from './managed-companion-reconcile.js';

/**
 * The Updater's execution loop (ADR 0008 D3/D7 standby promotion).
 *
 * The control boundary (`updater-status.ts`) only writes durable intent: it
 * journals an accepted request and hands back a 202. Everything that touches
 * Docker happens here, driven entirely by what the journal says — so a request,
 * a crash, and an Updater restart all enter through the same door and reach the
 * same place.
 */

const SERVER_VERSION_ENV = 'VERITY_SERVER_VERSION';
const DEV_VERSION = '0.0.0-dev';
const OFFICIAL_DIGEST = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;

/** Phases whose failure can still be recorded on the journal; from `standby`
 *  onwards preparation has already succeeded and the operation is resumable. */
const FAILABLE: readonly UpdatePhase[] = ['requested', 'pulling', 'verifying-image', 'preflight'];

const PREPARING: readonly UpdatePhase[] = [...FAILABLE, 'creating-standby'];

function isFailablePhase(
  phase: UpdatePhase,
): phase is 'requested' | 'pulling' | 'verifying-image' | 'preflight' {
  return FAILABLE.includes(phase);
}

function isPreparingPhase(
  phase: UpdatePhase,
): phase is Exclude<PreparationPhase, 'failed' | 'standby'> {
  return PREPARING.includes(phase);
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const defaultLog = (message: string): void => {
  console.log(`[self-update] ${message}`);
};

/**
 * What the Updater can attest to about a target image on its own.
 *
 * ADR 0008 D4 asks both sides to verify a release independently. The Server does
 * the full check — it fetches the signed channel document and verifies the
 * Sigstore bundle before it ever asks for a digest. The Updater cannot repeat
 * that: it runs with `network_mode: none` precisely because it holds the Docker
 * socket, so it can reach neither the registry nor a TUF root, and handing it a
 * network to re-verify a signature would trade a containment property for a
 * redundant one.
 *
 * What remains is still a real gate, and worth stating exactly:
 *
 * - the target must be a content-addressed digest on the OFFICIAL Server
 *   repository, so a compromised Server cannot point the Updater at an image it
 *   controls — only at some image ghcr serves under Verity's own package;
 * - the pull is by digest, so the daemon itself binds the bytes to that digest;
 * - the pulled image must declare a released `VERITY_SERVER_VERSION`, which a
 *   foreign or locally built image will not.
 *
 * The residual gap — a compromised Server could name an official digest the
 * channel does not advertise, e.g. an older one — is closed by the preflight
 * entrypoint, which runs IN the target image and refuses a build that cannot
 * operate the live schema generation.
 */
export function createOfficialImageVerifier(
  docker: Pick<DockerClient, 'inspectImageEnv'>,
): (journal: UpdateJournal) => Promise<void> {
  return async (journal) => {
    if (!OFFICIAL_DIGEST.test(journal.targetDigest))
      throw new Error('update target is not an official Verity Server digest');
    const environment = await specImageEnvironment(docker, journal.targetDigest);
    const entry = environment.find((item) => item.startsWith(`${SERVER_VERSION_ENV}=`));
    const version = entry?.slice(SERVER_VERSION_ENV.length + 1) ?? '';
    if (version === '' || version === DEV_VERSION)
      throw new Error('update target does not declare a released Verity Server version');
  };
}

export type UpdateRunnerDocker = StandbyPromotionDocker & UpdatePreparationDocker;

export interface UpdateRunnerOptions {
  /** Updater-owned root holding both the sealed spec and the update journal. */
  readonly managedRoot: string;
  readonly docker: UpdateRunnerDocker;
  /** Environment the sealed `env:` sources resolve against (the Updater's own). */
  readonly environment?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => Promise<string>;
  /** Defaults to {@link createOfficialImageVerifier}. */
  readonly verifyImage?: (journal: UpdateJournal) => Promise<void>;
  /** Reconcile every managed non-Server component onto the sealed image. The
   * production implementation performs a successor handoff for the Updater;
   * tests can inject the same transactional boundary without Docker. */
  readonly reconcileCompanions?: (journal: UpdateJournal) => Promise<void>;
  /** Probe endpoint and timings for the cutover; defaults suit a real host. */
  readonly cutover?: Omit<
    DockerStandbyPromotionOptions,
    'managedRoot' | 'docker' | 'environment' | 'readFile'
  >;
  readonly log?: (message: string) => void;
}

export interface UpdateRunner {
  /** Enqueue a run and resolve when it finishes. Never rejects: an operation's
   *  outcome belongs on the journal, not in the caller's error path. */
  run(): Promise<void>;
  /** Fire-and-forget entry point for the control boundary's accept callback. */
  start(): void;
  /** Whatever run is currently queued — for shutdown and for tests. */
  idle(): Promise<void>;
}

/** A recovered Updater, plus what its startup reconcile concluded about the
 *  Server it found. The verdict is carried out to `startUpdaterStatusServer` so
 *  `GET /v1/reconcile` can answer it; tolerated drift nobody can see is drift
 *  nobody fixes. */
export interface ManagedUpdaterRecovery extends UpdateRunner {
  readonly reconcile: ManagedServerReconcileVerdict;
}

/**
 * Carry the journalled operation from `requested` all the way to a terminal
 * phase, in the one process that owns the Docker socket.
 *
 * Runs are SERIALIZED. The journal is guarded by a single-writer lease that
 * refuses rather than waits, so two overlapping runs would not corrupt anything
 * but would make one of them fail for a reason that has nothing to do with the
 * update.
 */
export function createUpdateRunner(options: UpdateRunnerOptions): UpdateRunner {
  const log = options.log ?? defaultLog;
  const verifyImage = options.verifyImage ?? createOfficialImageVerifier(options.docker);
  const shared = {
    managedRoot: options.managedRoot,
    docker: options.docker,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };

  const execute = async (): Promise<void> => {
    let journal = await readUpdateJournal(options.managedRoot);
    if (journal === null) return;
    const terminal = isTerminalOperationState(projectUpdateOperation(journal).state);
    if (terminal && journal.phase !== 'committed') return;
    log(
      `operation ${journal.updateId} (generation ${String(journal.generation)}) resuming at ${journal.phase}`,
    );
    if (isPreparingPhase(journal.phase)) {
      const prepared = await resumeUpdatePreparation(
        options.managedRoot,
        await dockerUpdatePreparation({ ...shared, verifyImage }),
      );
      // Preparation reports failure by journalling it rather than by throwing,
      // so an unprepared operation has to be checked for, not caught.
      if (prepared.phase !== 'standby') {
        log(`operation ${journal.updateId} did not prepare: ${prepared.phase}`);
        return;
      }
      log(`operation ${journal.updateId} prepared ${prepared.targetDigest}; starting cutover`);
    }
    let phase = journal.phase;
    if (phase !== 'committed' && phase !== 'reconciling-companions') {
      const state = await resumeUpdateCutover(
        await dockerStandbyPromotion({ ...shared, ...(options.cutover ?? {}) }),
      );
      phase = state.phase;
    }
    if (phase === 'rolled-back') {
      await reconcileManagedControlPlaneRunner(shared);
      log(`operation ${journal.updateId} finished at ${phase}`);
      return;
    }
    await withUpdateJournalLease(options.managedRoot, async () => {
      let current = await readUpdateJournal(options.managedRoot);
      if (current === null) throw new Error('update journal disappeared before companion handoff');
      if (current.phase === 'committed') {
        current = await advanceCompanionReconciliation(
          options.managedRoot,
          'committed',
          'reconciling-companions',
        );
      }
      if (current.phase === 'reconciling-companions') {
        if (options.reconcileCompanions === undefined)
          await reconcileManagedCompanions({ ...shared, journal: current });
        else await options.reconcileCompanions(current);
        current = await advanceCompanionReconciliation(
          options.managedRoot,
          'reconciling-companions',
          'completed',
        );
      }
      journal = current;
    });
    log(`operation ${journal.updateId} finished at ${journal.phase}`);
  };

  /**
   * Record a failure that happened OUTSIDE the journalled steps — building the
   * Docker actions, reading the sealed authority — so the single slot does not
   * stay occupied by an operation that will never move and refuse every later
   * request with `operation-in-progress`. Phases from `standby` on are left
   * alone deliberately: there the operation is genuinely resumable, and the next
   * Updater start picks it up where it stopped.
   */
  const recordStuckFailure = async (): Promise<void> => {
    try {
      const current = await readUpdateJournal(options.managedRoot);
      if (current === null || !isFailablePhase(current.phase)) return;
      const phase = current.phase;
      await withUpdateJournalLease(options.managedRoot, async () => {
        const pinned = await readUpdateJournal(options.managedRoot);
        if (pinned?.phase !== phase) return;
        await failUpdate(options.managedRoot, phase, `${phase}-failed`);
      });
    } catch (error) {
      log(`could not record the failed operation: ${describe(error)}`);
    }
  };

  const run = async (): Promise<void> => {
    try {
      await execute();
    } catch (error) {
      log(`update operation failed: ${describe(error)}`);
      await recordStuckFailure();
    }
  };

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (): Promise<void> => {
    chain = chain.then(run);
    return chain;
  };
  return {
    run: enqueue,
    start: () => {
      void enqueue();
    },
    idle: () => chain,
  };
}

/**
 * Bring a starting Updater back to a consistent state: finish what the journal
 * still owns, THEN reconcile the Server against the sealed spec.
 *
 * The order carries the whole recovery argument. Activation advances the sealed
 * image before it removes the old container — it has to, because the advanced
 * spec is what a rebuild reads — so an Updater killed in that window comes back
 * to a Server running the previous digest under a spec naming the new one. The
 * reconciler judges that container a conflict and throws, which is right when it
 * is the only thing running, and fatal if it runs first: the Updater would exit
 * before reaching the journal, restart, and reject the same container again,
 * turning a recoverable update into a crash loop with no path out. Resuming
 * first closes the window, because the resumed operation rebuilds the Server
 * itself; reconciliation afterwards only faces the ordinary case of a Server
 * that is missing or stopped.
 *
 * Reconciliation is attempted either way — a resume that got as far as removing
 * the old container leaves no Server at all, and rebuilding it is exactly the
 * step the operation would take next — but whether its failure is fatal depends
 * on who owns the state. With nothing in flight, a failure means the Updater
 * cannot do its one job and exiting lets the restart policy retry. With an
 * unfinished operation, exiting would take the boundary down with it and hide
 * the stalled operation from the device that has to decide about it; there the
 * failure is logged, the Updater comes up, and a retry of the same request
 * re-arms execution.
 */
export async function recoverManagedUpdater(
  options: UpdateRunnerOptions,
): Promise<ManagedUpdaterRecovery> {
  const runner = createUpdateRunner(options);
  const verdict = (result: ManagedServerReconcileResult): ManagedServerReconcileVerdict =>
    result.drift === undefined || result.drift.length === 0
      ? { status: 'ok' }
      : { status: 'drift', environment: result.drift };
  // `'unknown'` until a reconcile actually returns one. The catch below swallows
  // the failure when an operation is unfinished, and claiming `'ok'` there would
  // report a verdict nothing reached.
  let reconcile: ManagedServerReconcileVerdict = { status: 'unknown' };
  const reportDrift = (result: ManagedServerReconcileVerdict): void => {
    if (result.status !== 'drift') return;
    // The Server is up and serving on values the spec now resolves differently.
    // Names only: these are secrets, and the log is not the place to widen the
    // blast radius of a configuration mistake.
    (options.log ?? defaultLog)(
      `the running Server predates the sealed environment for: ${result.environment.join(', ')}; it keeps serving and a restart of that container will rebuild it`,
    );
  };
  const companion = {
    managedRoot: options.managedRoot,
    docker: options.docker,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
  await runner.run();
  const journal = await readUpdateJournal(options.managedRoot);
  const pending =
    journal !== null && !isTerminalOperationState(projectUpdateOperation(journal).state)
      ? journal
      : null;
  try {
    // A terminal promoted/rolled-back operation already owns a concrete routed
    // container identity. Falling back to the historical unsuffixed bootstrap
    // name here would create a second Server beside that generation.
    if (
      journal?.phase === 'committed' ||
      journal?.phase === 'reconciling-companions' ||
      journal?.phase === 'completed' ||
      journal?.phase === 'rolled-back'
    ) {
      const status =
        options.cutover?.gateway === undefined
          ? await waitForManagedGatewayStatus(
              // Recovery reaches this before any ensureRunning() settle window,
              // so it alone can meet a Gateway Compose started milliseconds ago.
              options.cutover?.gatewayControlSocket ?? MANAGED_GATEWAY_CONTROL_SOCKET,
            )
          : await options.cutover.gateway.status();
      const host = status.backend.host;
      const match = /^verity-managed-server-g([1-9][0-9]{0,9})$/.exec(host);
      if (host !== MANAGED_SERVER_NAME && match === null)
        throw new Error('Gateway selected an invalid managed Server identity');
      const identity =
        match === null
          ? undefined
          : {
              name: host,
              operationId: generationOperationId(Number(match[1])),
              generation: Number(match[1]),
            };
      if (identity !== undefined) {
        const deployment = await readManagedDeployment(options.managedRoot);
        if (!deployment.managed)
          throw new Error(`managed Server authority unavailable: ${deployment.reason}`);
        await (options.cutover?.activate ?? openActivationGate)(
          identity.operationId,
          deployment.spec.user.gid,
        );
      }
      const reconciled = await reconcileManagedServer({
        managedRoot: options.managedRoot,
        docker: options.docker,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
        ...(identity === undefined ? {} : { identity }),
      });
      reconcile = verdict(reconciled);
      reportDrift(reconcile);
      await reconcileManagedControlPlaneRunner(companion);
      return { ...runner, reconcile };
    }
    const reconciled = await reconcileManagedServer({
      managedRoot: options.managedRoot,
      docker: options.docker,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    });
    reconcile = verdict(reconciled);
    reportDrift(reconcile);
    await reconcileManagedControlPlaneRunner(companion);
  } catch (error) {
    if (pending === null) throw error;
    (options.log ?? defaultLog)(
      `operation ${pending.updateId} is unfinished at ${pending.phase}; the Server is left as it stands: ${describe(error)}`,
    );
  }
  return { ...runner, reconcile };
}
