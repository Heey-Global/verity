/**
 * Live self-update smoke: drives the real self-update code — preparation AND the
 * generation-qualified standby promotion — against a real Docker daemon and the real Server image,
 * instead of a mocked DockerClient.
 *
 * Every other test of this path injects a fake `DockerClient`, so it only proves
 * that the code agrees with our model of Docker. This driver removes that
 * assumption: containers are really created, the shipped image's `preflight`,
 * `standby` and `readiness-probe` entrypoints really run, the readiness verdict
 * really crosses `verity-net` as a container exit code, and the journal really
 * survives separate processes (each stage below is its own `node` invocation, so
 * a stage that is re-run exercises the crash-resume path for free).
 *
 * The cutover is covered in both directions, because only one of them is safe to
 * get wrong: `cutover-rolls-back` proves a new generation that never answers
 * puts the old one back, and `cutover` proves a healthy one commits.
 *
 * Both ways of taking the control plane away from the outgoing Server are driven
 * too (ADR 0008 D9). `cutover-rolls-back` runs without a relay, so no exchange
 * exists and the cutover falls back to stopping the container — the path a
 * Server from an image predating the directive gets. `cutover-rolls-back-onto-
 * standby` and `cutover` run against a relay that owns a real `StandbyExchange`,
 * so the outgoing Server is asked, quiesces, and is still the same process when
 * the rollback hands the role back or the commit takes its key.
 *
 * So is what happens when the exchange itself goes wrong, which is the part with
 * a live Server on the other side and therefore the part no injected client can
 * reach. `cutover-standby-fails-to-resume` withholds the resume from a Server
 * that really quiesced, so the rollback probe meets a process holding no
 * listeners and has to stop it; `cutover-recovers-rollback` then finishes that
 * rollback from the container alone, which is the cold start the ADR says a
 * failed resume falls back to. `cutover-loses-the-request` destroys the one
 * directive the journal cannot express — the executor by exiting, the listener by
 * a refresh that publishes none — and the Server must come back serving on the
 * phase alone, in the same process, for the commit that follows to have anything
 * left to ask.
 *
 * The last thing that can go wrong is not a protocol failure at all: a process
 * dying where nothing gets to run. `cutover-halts-at` parks a real cutover at
 * each of the four moments the ADR's acceptance gate names — the open window,
 * the claimed generation, the switched route, the stabilization window — and the
 * driver delivers a `SIGKILL` from outside the update, which is the only place it
 * can come from and still mean anything. Two of those the update is meant to
 * survive: a candidate killed while holding its generation restarts and takes it
 * again, which is only true if PostgreSQL really released the session lock with
 * the process, and a standby killed inside the window costs its successor
 * nothing, because the key was sealed before there was a standby to kill. The
 * other two it is meant to undo, from further along than any probe failure can
 * reach: a Server that was serving when it died, with the Gateway already
 * pointed at it.
 *
 * Last is the update that already finished. In this topology the Server is not
 * a Compose service, so the digest an update selected lives in the Updater-owned
 * sealed spec while the Compose file goes on naming the one the host was
 * installed with. `updater-restarts` therefore restarts the committed deployment
 * the three ways a host does — a stopped Server, a removed one, the adoption job
 * re-run with the file's former digest still exported — through the real Updater
 * start path, and asserts what comes back is the generation the update selected
 * rather than the one the file names.
 *
 * Before any of that, `preflight-fails` and `preflight-fails-unreachable` drive
 * the two ways a candidate's database can refuse it: one that answers at a
 * schema this build cannot operate, and one that does not answer at all. They
 * are separate stages rather than one because the reports must differ — an
 * unmigrated database passes the `database` check and fails only on `schema`,
 * while an unreachable one fails the connection itself — and a single stage
 * could not tell a genuine refusal from the other one happening twice.
 *
 * `cutover-loses-the-database` is the same failure after the point preflight can
 * refuse at: the store goes away between the key handoff and the candidate's
 * first connection, so the candidate never answers and the quiesced generation
 * the rollback would return to cannot reclaim a control plane either. Both halves
 * fail, and what the stage is really about is what is left — an operation parked
 * in `rollback-activating-old` with its authority already back on the old digest,
 * which the recovery above finishes once the database returns.
 *
 * The caller supplies an ISOLATED daemon (see deploy/bin/verity-self-update-live-smoke).
 * That is not optional: the managed deployment's identifiers — the container names
 * `verity-managed-server` and `verity-managed-gateway`, the network `verity-net`,
 * the volumes `verity-data`, `verity-agent-gateway-control`,
 * `verity-managed-gateway-control` and `verity-updater-control` — are pinned by the
 * deployment-spec allowlist and therefore cannot be namespaced per CI run. Pointed
 * at a shared daemon this driver would adopt, and reconcile, that host's actual
 * Verity stack.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDockerClient, type DockerClient } from './docker.js';
import {
  initializeManagedDeployment,
  readManagedDeployment,
} from './self-update/managed-deployment.js';
import {
  MANAGED_SERVER_NAME,
  managedContainerMatchesSpec,
  managedServerContainerSpec,
  reconcileManagedServer,
  specImageEnvironment,
} from './self-update/managed-server-owner.js';
import { composeEnvironmentLines } from './self-update/compose-environment.js';
import { runManagedBootstrap } from './self-update/managed-bootstrap.js';
import { reconcileManagedCompanions } from './self-update/managed-companion-reconcile.js';
import { recoverManagedUpdater } from './self-update/update-runner.js';
import {
  dockerUpdatePreparation,
  generationOperationId,
} from './self-update/docker-update-preparation.js';
import { CandidatePreflightError } from './self-update/docker-update-preparation.js';
import {
  CandidateReadinessError,
  dockerStandbyPromotion,
} from './self-update/docker-in-place-cutover.js';
import type { PreflightCheck, PreflightReport } from './self-update/preflight.js';
import { DEFAULT_READINESS_PROBE_URL } from './self-update/readiness-probe.js';
import { MANAGED_GATEWAY_CONTROL_SOCKET } from './self-update/managed-gateway-control.js';
import type { ManagedGatewayBackend, ManagedGatewayStatus } from './self-update/managed-gateway.js';
import { ACTIVATION_GATE_DIRECTORY } from './self-update/activation-gate.js';
import { UPDATER_CONTROL_SOCKET } from './self-update/updater-status.js';
import { AGENT_SEED_MOUNT_PATH } from './self-update/agent-seed-stamp.js';
import {
  parseStandbyDirective,
  type StandbyDirective,
  type StandbyExchange,
} from './self-update/standby-directive.js';
import { resumeUpdatePreparation } from './self-update/update-preparation.js';
import {
  resumeUpdateCutover,
  type CutoverState,
  type UpdateCutoverDeps,
} from './self-update/update-cutover.js';
import {
  advanceCompanionReconciliation,
  archiveUpdateJournal,
  beginUpdate,
  readHighestGeneration,
  readUpdateJournal,
  withUpdateJournalLease,
  UPDATE_JOURNAL_FILE,
  type UpdateJournal,
  type UpdatePhase,
} from './self-update/update-journal.js';
import {
  MANAGED_SERVER_DEFAULT_RESOURCES,
  type ServerDeploymentSpecBody,
} from './self-update/deployment-spec.js';

/** Resolved from a `file:` deployment-spec source rather than the process
 *  environment, so the smoke covers both env-source kinds. `/run/secrets` is not
 *  writable on a CI runner, so the read is injected instead of faked away. */
const SECRET_FILE = '/run/secrets/verity-smoke-token';
const SECRET_VALUE = 'live-smoke-not-a-credential';

/** How long a Server on this runner is given to start answering `/healthz`.
 *  Generous on purpose: a real container start on a shared CI runner is the
 *  slowest thing in this smoke, and every scenario here asserts an outcome, not
 *  a duration. The one exception is the deliberately unserved candidate in the
 *  rollback scenario, which is bounded separately. */
const READINESS_TIMEOUT_MS = 120_000;
/** Budget for a probe that is MEANT to fail. Long enough that a slow container
 *  start cannot be mistaken for the failure, short enough not to stall the job. */
const UNSERVED_TIMEOUT_MS = 15_000;

/** The Updater-owned control volume carrying the activation gate. Pinned by the
 *  deployment-spec allowlist, like every other name in this deployment. */
const UPDATER_CONTROL_VOLUME = 'verity-updater-control';

/**
 * The smoke's own channel from this driver into the relay container (ADR 0008
 * D9) — deliberately NOT the control volume, which is the boundary under test.
 *
 * In production the Updater is one process: the control listener that publishes
 * the standby directive and the cutover executor that asks for a quiesce share
 * one `StandbyExchange` in memory. Here they are split across a host process and
 * a container, because the driver needs the runner's filesystem and the listener
 * needs the volume — so the two halves of that object need a channel, and this
 * volume is it. Everything it carries is what the real Updater would have had in
 * RAM: the journal the listener derives the directive from, and the one request
 * the journal cannot express.
 */
const STANDBY_VOLUME = 'verity-smoke-standby';
const STANDBY_DIRECTORY = '/run/verity-smoke';
const STANDBY_STATE_FILE = `${STANDBY_DIRECTORY}/standby.json`;

/**
 * The agent-seed volume used by containers in the isolated daemon.
 *
 * A volume rather than a bind, because this daemon is a Docker-in-Docker daemon
 * and a bind would name a path on the runner that no container here can reach.
 * What it stands in for is the directory the `verity-agent-seed` Compose
 * one-shot publishes into and the provisioner binds into every sandbox. The
 * shell driver also exports this volume's daemon-side mountpoint so the
 * simulated Updater below has the production bind-mount shape inspected by the
 * companion handoff, while every other smoke container can keep using the
 * portable named-volume form.
 */
const AGENT_SEED_DIRECTORY = AGENT_SEED_MOUNT_PATH;

/**
 * How long the cutover waits for the outgoing Server to answer a directive here.
 *
 * Far above the production default, and for reasons that are all artefacts of
 * the split above: publishing a request starts a container, the Server polls on
 * its own idle interval, and this driver reads the answer back out of the relay's
 * log. A short budget would make the smoke fall back to stopping the container —
 * a passing run that proved the opposite of what it was written for.
 */
const STANDBY_TIMEOUT_MS = 60_000;

/**
 * The same budget for the stage whose standby is MEANT to miss it.
 *
 * Shortened because that stage waits the window out twice over — once for a
 * resume that never comes, once for a probe against the Server that did not
 * resume — and a wait for an answer nobody is sending is pure wall-clock. It is
 * still what the same stage's real quiesce has to land inside, which is why it
 * is a third of the budget rather than a tenth: an acknowledgement here costs a
 * container start, a 200 ms relay tick, the Server's own poll interval and a
 * 500 ms mirror, so a few seconds on an idle runner. A window this stage
 * outgrows fails it on {@link quiescedNotStopped}, naming the quiesce, rather
 * than on the assertions further down.
 */
const WITHHELD_STANDBY_TIMEOUT_MS = 20_000;

function fail(message: string): never {
  throw new Error(`live self-update smoke failed: ${message}`);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') fail(`${name} is required`);
  return value;
}

function requiredArgument(index: number, description: string): string {
  const value = process.argv[index];
  if (value === undefined || value.trim() === '') fail(`${description} is required`);
  return value;
}

/** The Server environment a managed deployment injects. Mirrors the health-only
 *  values ci.yml's `server-image` smoke uses: no gateway is contacted and no
 *  project is provisioned, so the relay digest never resolves. */
function serverEnvironment(databaseUrl: string, deploymentId: string): NodeJS.ProcessEnv {
  return {
    HOST: '0.0.0.0',
    PORT: '8082',
    VERITY_INTERNAL_PORT: '8083',
    VERITY_ROOT: '/srv/verity',
    VERITY_REPO_DIR: '',
    VERITY_DOCKER_BASE_URL: 'unix:///var/run/docker.sock',
    VERITY_DATA_VOLUME: 'verity-data',
    VERITY_PROJECT_RELAY_IMAGE: `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'a'.repeat(64)}`,
    VERITY_AGENT_GATEWAY_CONTROL_SOCKET: '/run/verity-agent-gateway/control.sock',
    VERITY_AGENT_GATEWAY_URL: 'https://verity-agent-gateway:9443',
    VERITY_CLAUDE_EGRESS_GATEWAY_URL: 'https://verity:9443',
    VERITY_CLAUDE_CONNECTOR_PORT: '47821',
    DATABASE_URL: databaseUrl,
    VERITY_MANAGED_DEPLOYMENT_ID: deploymentId,
    VERITY_CONTROL_PLANE_HOLDER_ID: 'verity',
  };
}

function deploymentSpec(
  image: string,
): Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> {
  const fromEnv = (name: string) => ({ name, source: { kind: 'env' as const, name } });
  return {
    image,
    environment: [
      fromEnv('HOST'),
      fromEnv('PORT'),
      fromEnv('VERITY_INTERNAL_PORT'),
      fromEnv('VERITY_ROOT'),
      fromEnv('VERITY_REPO_DIR'),
      fromEnv('VERITY_DOCKER_BASE_URL'),
      fromEnv('VERITY_DATA_VOLUME'),
      fromEnv('VERITY_PROJECT_RELAY_IMAGE'),
      fromEnv('VERITY_AGENT_GATEWAY_CONTROL_SOCKET'),
      fromEnv('VERITY_AGENT_GATEWAY_URL'),
      fromEnv('VERITY_CLAUDE_EGRESS_GATEWAY_URL'),
      fromEnv('VERITY_CLAUDE_CONNECTOR_PORT'),
      fromEnv('DATABASE_URL'),
      fromEnv('VERITY_MANAGED_DEPLOYMENT_ID'),
      fromEnv('VERITY_CONTROL_PLANE_HOLDER_ID'),
      { name: 'VERITY_SMOKE_TOKEN', source: { kind: 'file' as const, path: SECRET_FILE } },
    ],
    mounts: [
      { source: { kind: 'volume', name: 'verity-data' }, target: '/srv/verity', readOnly: false },
      {
        source: { kind: 'volume', name: 'verity-agent-gateway-control' },
        target: '/run/verity-agent-gateway',
        readOnly: false,
      },
      {
        source: { kind: 'volume', name: UPDATER_CONTROL_VOLUME },
        target: ACTIVATION_GATE_DIRECTORY,
        readOnly: false,
      },
      {
        source: { kind: 'bind', path: '/var/run/docker.sock' },
        target: '/var/run/docker.sock',
        readOnly: false,
      },
    ],
    user: { uid: 1000, gid: 1000, supplementaryGids: [65532] },
    restart: 'unless-stopped',
    network: 'verity-net',
    platform: { os: 'linux', architecture: 'amd64' },
    security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: ['CHOWN'] },
  };
}

function docker(): DockerClient {
  return createDockerClient({ baseUrl: `unix://${required('VERITY_SMOKE_DOCKER_SOCKET')}` });
}

/** Stands in for the file the spec's `file:` environment source points at, with
 *  the trailing newline a real secret file carries. */
function readSecret(path: string): Promise<string> {
  if (path !== SECRET_FILE) fail(`unexpected secret read: ${path}`);
  return Promise.resolve(`${SECRET_VALUE}\n`);
}

function preparationOptions(managedRoot: string, databaseUrl: string, deploymentId: string) {
  return {
    managedRoot,
    docker: docker(),
    environment: serverEnvironment(databaseUrl, deploymentId),
    readFile: readSecret,
    // The signed-channel verifier (slice 1a) is exercised by its own unit suite
    // against fixture certificates; wiring a real Fulcio identity into CI needs a
    // published release, which a PR does not have. What this stands in for is the
    // one property preparation itself depends on: the digest reaching Docker is
    // the digest the operation authorized, never a tag or a substitute.
    verifyImage: (journal: UpdateJournal): Promise<void> => {
      expect(
        journal.targetDigest === required('VERITY_SMOKE_TARGET_DIGEST'),
        `verifier saw an unauthorized digest: ${journal.targetDigest}`,
      );
      return Promise.resolve();
    },
  };
}

async function adopt(managedRoot: string): Promise<void> {
  const previousDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const databaseUrl = required('VERITY_SMOKE_DATABASE_URL');
  const state = await initializeManagedDeployment({
    root: managedRoot,
    spec: deploymentSpec(previousDigest),
  });
  if (!state.managed) fail(`adoption did not produce a managed authority: ${state.reason}`);
  const client = docker();
  const first = await reconcileManagedServer({
    managedRoot,
    docker: client,
    environment: serverEnvironment(databaseUrl, state.spec.deploymentId),
    readFile: readSecret,
  });
  expect(first.action === 'created', `expected to create the managed Server, got ${first.action}`);

  // Re-adopting its own container is not a nicety: the updater re-runs this on
  // every start, and a mismatch here is what makes it refuse to manage the
  // deployment it just built.
  const second = await reconcileManagedServer({
    managedRoot,
    docker: client,
    environment: serverEnvironment(databaseUrl, state.spec.deploymentId),
    readFile: readSecret,
  });
  expect(
    second.action === 'unchanged' && second.containerId === first.containerId,
    `managed Server was not re-adopted: ${JSON.stringify(second)}`,
  );

  const inspect = await client.inspectContainer(first.containerId);
  expect(inspect.image === previousDigest, `managed Server runs ${String(inspect.image)}`);
  expect(inspect.running, 'managed Server is not running');
  // The spec sealed above carries no `resources`, exactly like every deployment
  // adopted before the field existed — so this is the old-spec/new-Server
  // direction against a real daemon, and it is the only place the ceilings can be
  // proved to survive the Docker API rather than merely be put in the request.
  // Re-adoption above already ran first: a limit the matcher rejected would have
  // failed there, not here.
  expect(
    inspect.memoryBytes === MANAGED_SERVER_DEFAULT_RESOURCES.memoryBytes &&
      inspect.memorySwapBytes === MANAGED_SERVER_DEFAULT_RESOURCES.memorySwapBytes &&
      inspect.nanoCpus === MANAGED_SERVER_DEFAULT_RESOURCES.nanoCpus &&
      inspect.pidsLimit === MANAGED_SERVER_DEFAULT_RESOURCES.pidsLimit,
    `managed Server host limits are not the Compose guardrails: ${JSON.stringify({
      memoryBytes: inspect.memoryBytes,
      memorySwapBytes: inspect.memorySwapBytes,
      nanoCpus: inspect.nanoCpus,
      pidsLimit: inspect.pidsLimit,
    })}`,
  );

  // Steady-state drift detection, against what the daemon actually reports rather
  // than a fixture. Docker spells "no limit" in several ways and normalizes the
  // values it echoes back, so this is the only place the comparison can be shown
  // to work on real inspect output.
  const desired = await managedServerContainerSpec(
    state.spec,
    serverEnvironment(databaseUrl, state.spec.deploymentId),
    readSecret,
  );
  const imageEnv = await specImageEnvironment(client, previousDigest);
  expect(
    managedContainerMatchesSpec(inspect, desired, imageEnv, false, 'exact'),
    'the live managed Server does not match its own spec under exact host limits',
  );
  const weakened = { ...desired, memoryBytes: 1024 ** 3, memorySwapBytes: 2 * 1024 ** 3 };
  expect(
    !managedContainerMatchesSpec(inspect, weakened, imageEnv, false, 'exact'),
    'a changed memory ceiling went undetected against a real container',
  );
  // …and the legacy tolerance still holds for the same pair, which is what keeps
  // a deployment sealed before the ceilings existed out of an Updater crash loop.
  expect(
    managedContainerMatchesSpec(inspect, weakened, imageEnv, false, 'ignored'),
    'the legacy host-limit tolerance rejected a container it must accept',
  );
  process.stdout.write(`adopted ${MANAGED_SERVER_NAME} as ${state.spec.deploymentId}\n`);
}

const TERMINAL_PHASES = new Set<UpdatePhase>(['completed', 'rolled-back', 'failed']);

/**
 * Claim the single journal slot, the way the Updater's control boundary does
 * (`updater-status.ts`): an unfinished operation on the same target is resumed
 * rather than restarted, and a finished one is archived first so its successor
 * can be numbered above every generation this deployment has ever reached.
 *
 * That archiving step is not incidental here. This smoke runs two operations
 * against the same managed root — one that rolls back and one that commits —
 * so the second `beginUpdate` only gets a free slot, and a generation that
 * forward-fences the first, because the terminal journal was moved aside.
 */
async function begin(managedRoot: string, targetDigest: string): Promise<UpdateJournal> {
  const state = await readManagedDeployment(managedRoot);
  if (!state.managed) fail(`managed authority unavailable: ${state.reason}`);
  return withUpdateJournalLease(managedRoot, async () => {
    const existing = await readUpdateJournal(managedRoot);
    if (existing !== null && !TERMINAL_PHASES.has(existing.phase)) {
      if (existing.targetDigest !== targetDigest)
        fail(`an unfinished operation targets ${existing.targetDigest}`);
      return existing;
    }
    if (existing !== null) await archiveUpdateJournal(managedRoot);
    const currentGeneration = await readHighestGeneration(managedRoot);
    return beginUpdate({
      root: managedRoot,
      deploymentId: state.spec.deploymentId,
      idempotencyKey: `live-smoke-g${String(currentGeneration + 1)}`,
      currentGeneration,
      previousDigest: state.spec.image,
      targetDigest,
    });
  });
}

async function prepare(managedRoot: string): Promise<void> {
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const databaseUrl = required('VERITY_SMOKE_DATABASE_URL');
  const started = await begin(managedRoot, targetDigest);
  const state = await readManagedDeployment(managedRoot);
  if (!state.managed) fail('managed authority disappeared mid-preparation');
  // Refused here rather than left to weaken the assertions downstream. Every
  // stage that checks an outcome checks it as an image — the authority kept the
  // previous digest, the promoted generation runs the target — and an operation
  // whose two digests are the same makes both of those true no matter what the
  // cutover did. The driver mints one digest per commit to keep them apart; a
  // generation added without one fails here instead of passing vacuously.
  expect(
    state.spec.image !== targetDigest,
    `this generation targets the digest it is already running: ${targetDigest}`,
  );
  const options = preparationOptions(managedRoot, databaseUrl, state.spec.deploymentId);
  const deps = await dockerUpdatePreparation(options);

  const journal = await resumeUpdatePreparation(managedRoot, deps);
  expect(journal.phase === 'standby', `preparation stopped in ${journal.phase}`);
  if (journal.candidate === null) fail('preparation reached standby without a candidate');

  const client = docker();
  const candidate = await client.inspectContainer(journal.candidate.containerId);
  expect(candidate.running, 'standby candidate is not running');
  expect(candidate.image === targetDigest, `standby runs ${String(candidate.image)}`);
  // It carries the complete production spec but cannot pass the PostgreSQL
  // activation fence while the incumbent is alive.
  expect(
    candidate.networkMode === state.spec.network,
    `standby is attached to ${String(candidate.networkMode)}`,
  );
  expect(
    (candidate.env ?? []).some((entry) => entry === 'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION=1'),
    'standby does not wait behind the activation fence',
  );
  expect(
    (candidate.env ?? []).some((entry) => entry.startsWith('DATABASE_URL=')),
    'standby lacks its production database source',
  );
  expect((candidate.mounts ?? []).length > 0, 'standby lacks production mounts');

  // The preflight container is a throwaway: it must not survive its own run,
  // or the next generation inherits a stale name.
  const names = (await client.listContainers!()).flatMap((item) => item.names ?? []);
  expect(
    !names.includes(`verity-managed-preflight-g${String(journal.generation)}`),
    'preflight container outlived its run',
  );

  // Resume is the crash path. Re-running must land on the same candidate rather
  // than build a second one.
  const resumed = await resumeUpdatePreparation(
    managedRoot,
    await dockerUpdatePreparation(options),
  );
  expect(
    resumed.candidate?.containerId === journal.candidate.containerId,
    'resume created a second candidate',
  );
  expect(resumed.generation === started.generation, 'resume moved the generation');
  process.stdout.write(`prepared generation ${String(journal.generation)} on ${targetDigest}\n`);
}

/**
 * The preflight report the failed container printed, recovered from its logs.
 *
 * `JSON.stringify(report, null, 2)` is the entrypoint's only stdout write, so
 * the document opens on a line that is exactly `{` and closes on one that is
 * exactly `}`. Anchoring on those keeps a brace inside some earlier log line
 * out of the parse.
 */
function preflightReport(diagnostics: string): PreflightReport {
  const lines = diagnostics.split('\n').map((line) => line.trimEnd());
  const start = lines.lastIndexOf('{');
  const end = lines.lastIndexOf('}');
  if (start < 0 || end <= start) fail(`preflight failure carried no report:\n${diagnostics}`);
  const body = lines.slice(start, end + 1).join('\n');
  try {
    return JSON.parse(body) as PreflightReport;
  } catch (error) {
    fail(`preflight report did not parse (${String(error)}):\n${body}`);
  }
}

function preflightCheck(report: PreflightReport, name: string): PreflightCheck {
  const check = report.checks.find((item) => item.name === name);
  if (check === undefined) {
    fail(`preflight report carries no ${name} check: ${JSON.stringify(report.checks)}`);
  }
  return check;
}

/** Which half of "database unavailable and schema incompatible" a run drives. */
type PreflightRefusal = 'unmigrated' | 'unreachable';

/**
 * The gate ADR 0008 exists for: a candidate that cannot operate the live
 * database must never reach standby. The unit suite proves the journal
 * transition against fakes; only this proves the shipped image's `preflight`
 * entrypoint actually exits non-zero on it, and that the Updater turns that
 * exit into a failed journal with nothing left behind to adopt.
 *
 * Both refusals run against a real database address:
 *
 * - `unmigrated` answers, at zero applied migrations. The `database` check must
 *   PASS and the `schema` check must fail — asserting the pass is what stops
 *   this stage from silently degrading into the other one.
 * - `unreachable` is a live host with nothing listening on the port, which is
 *   what a database that is down looks like from inside the network. Here the
 *   `database` check itself must fail, and the schema must be unreadable rather
 *   than merely wrong.
 *
 * Both are before activation. Losing the database *after* activation is a
 * different gate and is not covered here — see the ADR's gate coverage table.
 */
async function preflightFails(refusal: PreflightRefusal): Promise<void> {
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const databaseUrl = required(
    refusal === 'unmigrated'
      ? 'VERITY_SMOKE_UNMIGRATED_DATABASE_URL'
      : 'VERITY_SMOKE_UNREACHABLE_DATABASE_URL',
  );
  const managedRoot = await mkdtemp(join(tmpdir(), `verity-smoke-${refusal}-`));
  const state = await initializeManagedDeployment({
    root: managedRoot,
    spec: deploymentSpec(required('VERITY_SMOKE_PREVIOUS_DIGEST')),
  });
  if (!state.managed) fail(`adoption did not produce a managed authority: ${state.reason}`);
  await begin(managedRoot, targetDigest);

  const deps = await dockerUpdatePreparation(
    preparationOptions(managedRoot, databaseUrl, state.spec.deploymentId),
  );
  let raised: unknown;
  try {
    await resumeUpdatePreparation(managedRoot, deps);
  } catch (error) {
    raised = error;
  }
  if (!(raised instanceof CandidatePreflightError)) {
    fail(`expected a candidate preflight failure, got ${String(raised)}`);
  }

  const report = preflightReport(raised.diagnostics);
  expect(!report.ok, 'preflight reported ready on a database it had to refuse');
  const database = preflightCheck(report, 'database');
  const schema = preflightCheck(report, 'schema');
  expect(schema.status === 'fail', `schema check ${schema.status} on a ${refusal} database`);
  expect(
    report.schema.executed === null,
    `preflight read schema generation ${String(report.schema.executed)}`,
  );
  if (refusal === 'unmigrated') {
    expect(
      database.status === 'pass',
      `an answering database failed its own check: ${String(database.detail)}`,
    );
  } else {
    expect(
      database.status === 'fail',
      'preflight passed the database check against an address nothing serves',
    );
    // The refusal has to be the connection, not some later parse or permission
    // error that would also fail the check for the wrong reason.
    expect(
      (database.detail ?? '').includes('ECONNREFUSED'),
      `database check failed on something other than the connection: ${String(database.detail)}`,
    );
  }

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'failed', `journal settled in ${String(journal?.phase)}`);
  expect(
    journal?.failure?.code === 'preflight-failed',
    `journal recorded ${String(journal?.failure?.code)}`,
  );

  // A failed preparation must leave nothing behind to adopt.
  const names = (await docker().listContainers!()).flatMap((item) => item.names ?? []);
  expect(
    !names.some((name) => name.startsWith('verity-managed-preflight-')),
    'failed preflight left its container behind',
  );
  expect(
    !names.some((name) => name.startsWith('verity-managed-standby-')),
    'failed preparation produced a standby anyway',
  );
  process.stdout.write(`preflight failed closed on an ${refusal} database\n`);
}

/**
 * The real Gateway container, and the volume its control socket lives on.
 *
 * Started once by the driver and never replaced, because that is what a Gateway
 * is: the stable front door a Server generation is swapped out behind. Every
 * route selection below is made on this process, over the shipped control
 * channel, and persisted by it — so the Gateway outlives each stage the way it
 * outlives an update, and nothing here has to model what it remembers.
 */
const GATEWAY_NAME = 'verity-managed-gateway';
const GATEWAY_CONTROL_VOLUME = 'verity-managed-gateway-control';
const GATEWAY_CONTROL_DIRECTORY = '/run/verity-gateway';

/** Printed by the control container, so the driver can read a typed answer back
 *  out of a container log — the only channel it has to one. */
const GATEWAY_CONTROL_RESULT = 'gateway-control';

/**
 * Call the Gateway's control channel the way the Updater does: as root, from a
 * container that mounts the control volume, over the shipped client.
 *
 * The obvious alternative — this driver opening the socket itself — is not
 * available and would not be worth much if it were. The daemon under test is a
 * Docker-in-Docker daemon, so the volume the socket lives on exists only inside
 * it; and the property the channel is supposed to have is precisely that a root
 * process in ONE container can drive a Gateway running as uid 1000 in another
 * through a `0600` socket on a shared volume. A client in this process would
 * assert none of that. So the shipped `managed-gateway-control` client runs
 * unmodified, one throwaway container per call, and its result comes back as a
 * log line.
 *
 * The cost is a container start per instruction, which is why the executor's
 * calls are the only ones that go through here.
 */
async function gatewayControl<T>(
  call:
    | { readonly method: 'status' | 'enterMaintenance' | 'leaveMaintenance' }
    | { readonly method: 'drain'; readonly timeoutMs: number }
    | { readonly method: 'switchBackend'; readonly backend: ManagedGatewayBackend },
): Promise<{ readonly value: T; readonly elapsedMs: number }> {
  const client = docker();
  const created = await client.createContainer({
    image: required('VERITY_SMOKE_PREVIOUS_DIGEST'),
    name: `verity-smoke-gateway-control-${randomBytes(6).toString('hex')}`,
    entrypoint: ['node'],
    command: [
      '-e',
      `(async () => {
        const control = await import(process.env.VERITY_SMOKE_GATEWAY_MODULE);
        const call = JSON.parse(process.env.VERITY_SMOKE_GATEWAY_CALL);
        const socket = process.env.VERITY_SMOKE_GATEWAY_SOCKET;
        const run = {
          status: () => control.readManagedGatewayStatus(socket),
          enterMaintenance: () => control.enterManagedGatewayMaintenance(socket),
          leaveMaintenance: () => control.leaveManagedGatewayMaintenance(socket),
          drain: () => control.drainManagedGateway(socket, call.timeoutMs),
          switchBackend: () => control.switchManagedGatewayBackend(socket, call.backend),
        }[call.method];
        if (run === undefined) throw new Error('unknown gateway control call: ' + call.method);
        // Timed here rather than by the caller: a container start is the same
        // order of magnitude as a drain window, so a duration measured around
        // this container could not tell a drain that used its whole budget from
        // one that gave up early and was padded by the start. What is left in
        // this number is a unix-socket round trip.
        const startedAt = Date.now();
        const value = (await run()) ?? null;
        console.log(
          '${GATEWAY_CONTROL_RESULT} ' +
            JSON.stringify({ value, elapsedMs: Date.now() - startedAt }),
        );
      })().catch((error) => { console.error(error); process.exit(1); })`,
    ],
    env: [
      'VERITY_SMOKE_GATEWAY_MODULE=file:///app/packages/server/dist/self-update/managed-gateway-control.js',
      `VERITY_SMOKE_GATEWAY_SOCKET=${MANAGED_GATEWAY_CONTROL_SOCKET}`,
      `VERITY_SMOKE_GATEWAY_CALL=${JSON.stringify(call)}`,
    ],
    // Root and networkless, exactly like the Updater: the only thing this
    // container is allowed to reach is the socket on the mounted volume.
    user: '0:0',
    groupAdd: [],
    binds: [],
    volumeMounts: [{ volume: GATEWAY_CONTROL_VOLUME, target: GATEWAY_CONTROL_DIRECTORY }],
    network: 'none',
    restartPolicy: 'no',
  });
  try {
    await client.startContainer(created.id);
    // A drain holds its connection open for the whole window it was given, so
    // the wait cannot be bounded tighter than the call it is carrying.
    const exitCode = await client.waitContainer!(created.id);
    const logs = await client.containerLogs!(created.id, 50);
    if (exitCode !== 0) fail(`gateway ${call.method} exited ${String(exitCode)}: ${logs}`);
    const line = logs
      .split('\n')
      .map((entry) => entry.trim())
      .reverse()
      .find((entry) => entry.startsWith(`${GATEWAY_CONTROL_RESULT} `));
    if (line === undefined) fail(`gateway ${call.method} produced no result: ${logs}`);
    return JSON.parse(line.slice(GATEWAY_CONTROL_RESULT.length + 1)) as {
      value: T;
      elapsedMs: number;
    };
  } finally {
    await client.removeContainer(created.id).catch(() => undefined);
  }
}

/** The same call for everything that wants the answer and not the clock. */
async function gatewayCall<T>(call: Parameters<typeof gatewayControl>[0]): Promise<T> {
  return (await gatewayControl<T>(call)).value;
}

/** What the Gateway is routing right now, straight from the Gateway. */
async function routedBackend(): Promise<ManagedGatewayBackend> {
  return (await gatewayCall<ManagedGatewayStatus>({ method: 'status' })).backend;
}

/** A promoted candidate keeps the name preparation gave it, so the unsuffixed
 *  name only survives until the run's first commit. */
const SERVER_GENERATION_NAME = /^verity-managed-server-g[1-9][0-9]*$/;

function serverName(names: readonly string[] | undefined): string | undefined {
  return (names ?? []).find(
    (name) => name === MANAGED_SERVER_NAME || SERVER_GENERATION_NAME.test(name),
  );
}

/** The one container the Gateway is sending traffic to. */
async function managedServer(client: DockerClient) {
  const routed = (await routedBackend()).host;
  const matches = (await client.listContainers!()).filter((item) => item.names?.includes(routed));
  if (matches.length !== 1) fail(`expected exactly one ${routed}, found ${String(matches.length)}`);
  return client.inspectContainer(matches[0]!.id);
}

/** Every managed container except the Server and the Gateway itself is a
 *  scaffold — standby, preflight, readiness probe. An operation that finished
 *  must own none of them, whichever way it ended. */
async function expectNoScaffolding(client: DockerClient, after: string): Promise<void> {
  const left = (await client.listContainers!())
    .flatMap((item) => item.names ?? [])
    .filter(
      (name) =>
        name.startsWith('verity-managed-') &&
        name !== GATEWAY_NAME &&
        serverName([name]) === undefined,
    );
  expect(left.length === 0, `${after} left ${left.join(', ')} behind`);
}

/**
 * Publish the real activation gate the way the Updater does: as root, into the
 * control volume the candidate has mounted.
 *
 * This driver runs as an ordinary CI user with no such mount, so it cannot call
 * `openActivationGate` in-process — and stubbing the marker out would skip the
 * one property no in-process fake can reach: a root-owned, group-readable file
 * crossing a volume boundary and being ACCEPTED by a Server running as uid 1000,
 * whose `waitForActivationGate` re-checks owner, group and mode before it lets
 * the new generation claim the control plane. So the shipped function runs
 * unmodified, in a throwaway root container built from the same image.
 */
async function publishActivationGate(operationId: string, peerGid: number): Promise<void> {
  const client = docker();
  const name = `verity-smoke-activation-gate-${operationId}`;
  // A crashed earlier attempt can leave the publisher behind; the daemon is
  // throwaway and this name belongs to the smoke alone, so reclaim it.
  const stale = (await client.listContainers!()).find((item) => item.names?.includes(name));
  if (stale !== undefined) await client.removeContainer(stale.id);
  const created = await client.createContainer({
    image: required('VERITY_SMOKE_PREVIOUS_DIGEST'),
    name,
    entrypoint: ['node'],
    command: [
      '-e',
      'import(process.env.VERITY_SMOKE_GATE_MODULE).then((gate) => gate.openActivationGate(process.env.VERITY_SMOKE_GATE_ID, Number(process.env.VERITY_SMOKE_GATE_GID))).catch((error) => { console.error(error); process.exit(1); })',
    ],
    env: [
      'VERITY_SMOKE_GATE_MODULE=file:///app/packages/server/dist/self-update/activation-gate.js',
      `VERITY_SMOKE_GATE_ID=${operationId}`,
      `VERITY_SMOKE_GATE_GID=${String(peerGid)}`,
    ],
    user: '0:0',
    groupAdd: [],
    binds: [],
    volumeMounts: [{ volume: UPDATER_CONTROL_VOLUME, target: ACTIVATION_GATE_DIRECTORY }],
    restartPolicy: 'no',
    network: 'none',
  });
  try {
    await client.startContainer(created.id);
    const exitCode = await client.waitContainer!(created.id);
    if (exitCode !== 0)
      fail(
        `activation gate publisher exited ${String(exitCode)}: ${await client.containerLogs!(created.id, 50)}`,
      );
  } finally {
    await client.removeContainer(created.id).catch(() => undefined);
  }
}

/** The relay standing in for the Updater's control boundary (ADR 0008 D8). */
const HANDOFF_RELAY_NAME = 'verity-smoke-handoff-relay';
/** Printed by the relay once its listener is bound and the token is published. */
const HANDOFF_RELAY_READY = 'handoff relay listening';
/** Prefix of the relay's standby line: `<prefix> <operationId> <requested> <acknowledged>`,
 *  with `-` for either half that is not set. Printed on change only. */
const HANDOFF_RELAY_STANDBY = 'standby-state';

/**
 * Run the real Updater control boundary, so the two Servers have the channel the
 * secret-key handoff needs (ADR 0008 D8).
 *
 * There is no Updater process in this smoke — the driver plays that part — but
 * the mailbox lives inside `startUpdaterStatusServer` and is reachable only over
 * a unix socket in the control volume. A fake would prove nothing: what has to
 * hold is that a socket and a `root:<gid>` token created by a root process in
 * one container are usable by a Server running as uid 1000 in another, that the
 * outgoing Server's envelope survives the round trip, and that the promoted
 * container can open it. So the shipped listener runs unmodified, in a throwaway
 * root container built from the same image.
 *
 * It is fed a COPY of the journal rather than the live file, because the daemon
 * under test is a Docker-in-Docker daemon: the driver's managed root is on the
 * runner's filesystem, which no container here can see. The copy is refreshed
 * through {@link STANDBY_STATE_FILE} whenever the driver has a reason to — which
 * is what makes the standby directive it derives track the real operation rather
 * than the instant this container started.
 *
 * It also owns the run's `StandbyExchange`. In production that object is shared
 * in memory with the cutover executor; here the executor is this driver, so the
 * exchange lives on the listener's side of the boundary and the driver reaches
 * it through the same file. What it publishes back — the request it is holding
 * and the answer it was given — goes to stdout, because container logs are a
 * channel the driver already has.
 */
async function startHandoffRelay(managedRoot: string): Promise<void> {
  const journal = await readUpdateJournal(managedRoot);
  if (journal === null || journal.candidate === null)
    fail('the handoff relay needs a prepared candidate');
  const client = docker();
  const stale = (await client.listContainers!()).find((item) =>
    item.names?.includes(HANDOFF_RELAY_NAME),
  );
  if (stale !== undefined) await client.removeContainer(stale.id);
  const snapshot = await readFile(join(managedRoot, UPDATE_JOURNAL_FILE));
  const created = await client.createContainer({
    image: required('VERITY_SMOKE_PREVIOUS_DIGEST'),
    name: HANDOFF_RELAY_NAME,
    entrypoint: ['node'],
    command: [
      '-e',
      `(async () => {
        const { mkdir, writeFile, chmod, readFile, rename } = await import('node:fs/promises');
        const root = '/srv/journal';
        await mkdir(root, { recursive: true });
        await chmod(root, 0o700);
        const path = root + '/${UPDATE_JOURNAL_FILE}';
        // Renamed into place so a request served mid-refresh reads either the
        // whole previous journal or the whole new one.
        const writeJournal = async (encoded) => {
          await writeFile(path + '.tmp', Buffer.from(encoded, 'base64'), { mode: 0o600 });
          await chmod(path + '.tmp', 0o600);
          await rename(path + '.tmp', path);
        };
        let journal = process.env.VERITY_SMOKE_RELAY_JOURNAL;
        await writeJournal(journal);
        const updater = await import(process.env.VERITY_SMOKE_RELAY_MODULE);
        const directive = await import(process.env.VERITY_SMOKE_STANDBY_MODULE);
        const exchange = directive.createStandbyExchange();
        await updater.startUpdaterStatusServer({
          socketPath: process.env.VERITY_SMOKE_RELAY_SOCKET,
          token: process.env.VERITY_SMOKE_RELAY_TOKEN,
          managedRoot: root,
          peerGid: Number(process.env.VERITY_SMOKE_RELAY_GID),
          standby: exchange,
          agentSeedPath: process.env.VERITY_SMOKE_AGENT_SEED,
        });
        console.log('${HANDOFF_RELAY_READY}');
        let published = '';
        const tick = async () => {
          try {
            const state = JSON.parse(await readFile(process.env.VERITY_SMOKE_STANDBY_STATE, 'utf8'));
            if (typeof state.journal === 'string' && state.journal !== journal) {
              journal = state.journal;
              await writeJournal(journal);
            }
            // Re-applied every tick rather than on change: the exchange keeps an
            // answer to a request that repeats, so this is idempotent, and a
            // relay that restarted would otherwise serve a directive the cutover
            // asked for before it did.
            //
            // A published state with NO request is the Updater's memory after a
            // crash. Half of that memory is really gone — the executor is the
            // driver's own process, and the stage that asked for a quiesce has
            // exited — so this is the listener half forgetting with it. \`discard\`
            // is what the boundary calls when it closes, and what a Server then
            // polls is the journal-derived directive, which is the whole reason
            // it is derived.
            if (state.request)
              exchange.request(state.request.operationId, state.request.directive);
            else exchange.discard();
          } catch (error) {
            if (error.code !== 'ENOENT') console.error(error);
          }
          const operationId =
            'generation-' + JSON.parse(Buffer.from(journal, 'base64').toString('utf8')).generation;
          const line =
            '${HANDOFF_RELAY_STANDBY} ' + operationId +
            ' ' + (exchange.requested(operationId) ?? '-') +
            ' ' + (exchange.acknowledged(operationId) ?? '-');
          if (line !== published) { published = line; console.log(line); }
        };
        setInterval(() => void tick(), 200);
      })().catch((error) => { console.error(error); process.exit(1); })`,
    ],
    env: [
      'VERITY_SMOKE_RELAY_MODULE=file:///app/packages/server/dist/self-update/updater-status.js',
      'VERITY_SMOKE_STANDBY_MODULE=file:///app/packages/server/dist/self-update/standby-directive.js',
      `VERITY_SMOKE_RELAY_SOCKET=${UPDATER_CONTROL_SOCKET}`,
      `VERITY_SMOKE_RELAY_JOURNAL=${snapshot.toString('base64')}`,
      `VERITY_SMOKE_STANDBY_STATE=${STANDBY_STATE_FILE}`,
      // Production reports the immutable selection, not the legacy flat root.
      // The pointer does not exist until companion handoff publishes it; the
      // status route resolves this path afresh for every request.
      `VERITY_SMOKE_AGENT_SEED=${join(AGENT_SEED_DIRECTORY, '.current')}`,
      // Minted here and never written down on the runner: the Servers read it
      // from the file the listener publishes, which is the production path.
      `VERITY_SMOKE_RELAY_TOKEN=${randomBytes(32).toString('hex')}`,
      'VERITY_SMOKE_RELAY_GID=1000',
    ],
    user: '0:0',
    groupAdd: [],
    // Read through the same daemon-host bind the managed Updater exposes to
    // the companion handoff. Keeping the relay on the named-volume mount would
    // give it a different mount view from the helper that advances `.current`
    // and leaves the Server reporting the legacy seed after a successful
    // publication.
    binds: [`${required('VERITY_SMOKE_AGENT_SEED_HOST_PATH')}:${AGENT_SEED_DIRECTORY}:ro`],
    volumeMounts: [
      { volume: UPDATER_CONTROL_VOLUME, target: ACTIVATION_GATE_DIRECTORY },
      { volume: STANDBY_VOLUME, target: STANDBY_DIRECTORY },
    ],
    restartPolicy: 'no',
    network: 'none',
  });
  await client.startContainer(created.id);
  for (let attempt = 0; ; attempt += 1) {
    const logs = await client.containerLogs!(created.id, 50);
    if (logs.includes(HANDOFF_RELAY_READY)) break;
    const state = await client.inspectContainer(created.id);
    if (!state.running) fail(`handoff relay exited: ${logs}`);
    if (attempt === 60) fail(`handoff relay never bound its socket: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write(
    `handoff relay serving generation ${String(journal.generation)} on ${UPDATER_CONTROL_SOCKET}\n`,
  );
}

async function relayContainer(client: DockerClient): Promise<string> {
  const found = (await client.listContainers!()).find((item) =>
    item.names?.includes(HANDOFF_RELAY_NAME),
  );
  if (found === undefined) fail('the standby exchange needs a running handoff relay');
  return found.id;
}

/**
 * Hand the relay the journal this driver is working from, and — when the cutover
 * has asked for one — the request that goes with it.
 *
 * Written by a throwaway root container for the same reason the activation gate
 * is: this driver has no mount into the isolated daemon's volumes. Renamed into
 * place so the relay's 200 ms poll never reads half a file.
 */
async function publishStandbyState(
  managedRoot: string,
  request: { readonly operationId: string; readonly directive: StandbyDirective } | null,
): Promise<void> {
  const journal = await readFile(join(managedRoot, UPDATE_JOURNAL_FILE));
  const client = docker();
  const name = 'verity-smoke-standby-state';
  const stale = (await client.listContainers!()).find((item) => item.names?.includes(name));
  if (stale !== undefined) await client.removeContainer(stale.id);
  const created = await client.createContainer({
    image: required('VERITY_SMOKE_PREVIOUS_DIGEST'),
    name,
    entrypoint: ['node'],
    command: [
      '-e',
      `(async () => {
        const { writeFile, rename } = await import('node:fs/promises');
        const path = process.env.VERITY_SMOKE_STANDBY_STATE;
        await writeFile(path + '.tmp', process.env.VERITY_SMOKE_STANDBY_PAYLOAD, { mode: 0o600 });
        await rename(path + '.tmp', path);
      })().catch((error) => { console.error(error); process.exit(1); })`,
    ],
    env: [
      `VERITY_SMOKE_STANDBY_STATE=${STANDBY_STATE_FILE}`,
      `VERITY_SMOKE_STANDBY_PAYLOAD=${JSON.stringify({
        journal: journal.toString('base64'),
        request,
      })}`,
    ],
    user: '0:0',
    groupAdd: [],
    binds: [],
    volumeMounts: [{ volume: STANDBY_VOLUME, target: STANDBY_DIRECTORY }],
    restartPolicy: 'no',
    network: 'none',
  });
  try {
    await client.startContainer(created.id);
    const exitCode = await client.waitContainer!(created.id);
    if (exitCode !== 0)
      fail(
        `standby state publisher exited ${String(exitCode)}: ${await client.containerLogs!(created.id, 50)}`,
      );
  } finally {
    await client.removeContainer(created.id).catch(() => undefined);
  }
}

interface SmokeStandby {
  /** What the cutover is handed in place of the Updater's in-memory exchange. */
  readonly exchange: StandbyExchange;
  /** Publishing failures, which must fail a stage rather than quietly become a
   *  timeout — a timeout here reads as "the Server did not answer" and would let
   *  the cutover fall back to stopping the container and still pass. */
  readonly failures: readonly unknown[];
  stop(): void;
}

/**
 * This driver's half of the standby exchange (ADR 0008 D9).
 *
 * The cutover's own contract is unchanged — it records a request and reads back
 * what the Server acknowledged — but each half now crosses the container
 * boundary: a request is published into the relay's state file, and the answer
 * is mirrored back out of the relay's log.
 *
 * An acknowledgement is only accepted from a relay line that already carries the
 * request this driver last made. Without that, the `serving` a Server posts
 * before a cutover asks anything would still be on the line when the quiesce is
 * withdrawn, and the wait for it to serve again would resolve instantly against
 * an answer to an older question.
 */
function smokeStandbyExchange(managedRoot: string, relayContainerId: string): SmokeStandby {
  const client = docker();
  const failures: unknown[] = [];
  let asked: { operationId: string; directive: StandbyDirective } | undefined;
  let acknowledged: StandbyDirective | null = null;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;

  const mirror = async (): Promise<void> => {
    const logs = await client.containerLogs!(relayContainerId, 20);
    const line = logs
      .split('\n')
      .filter((entry) => entry.startsWith(`${HANDOFF_RELAY_STANDBY} `))
      .at(-1);
    if (line === undefined || asked === undefined) return;
    const [, operationId, requested, answer] = line.trim().split(' ');
    if (operationId !== asked.operationId || requested !== asked.directive) return;
    acknowledged = answer === undefined || answer === '-' ? null : parseStandbyDirective(answer);
  };
  const poll = setInterval(() => {
    void mirror().catch((error: unknown) => failures.push(error));
  }, 500);

  return {
    failures,
    stop: () => {
      stopped = true;
      clearInterval(poll);
    },
    exchange: {
      request: (operationId, directive) => {
        if (asked?.operationId !== operationId || asked.directive !== directive)
          acknowledged = null;
        const pending = { operationId, directive };
        asked = pending;
        // The request that is published is the one this call made, not whatever
        // `asked` has become by the time the queue reaches it: publishes are
        // serialised, and a later one overwriting an earlier one in flight would
        // drop a directive the cutover is already waiting on an answer to.
        queue = queue
          .then(() => (stopped ? undefined : publishStandbyState(managedRoot, pending)))
          .catch((error: unknown) => {
            failures.push(error);
          });
      },
      requested: (operationId) => (asked?.operationId === operationId ? asked.directive : null),
      acknowledged: (operationId) => (asked?.operationId === operationId ? acknowledged : null),
      // The Server acknowledges to the relay, over the real control socket; the
      // exchange holding those answers is the relay's, not this one.
      acknowledge: () => undefined,
      discard: () => {
        asked = undefined;
        acknowledged = null;
      },
    },
  };
}

/**
 * The cutover executor as the Updater builds it, with the wall-clock shortened.
 * The observation window is the phase under test, not its duration.
 */
/**
 * The Updater's side of the Gateway control channel, one container per
 * instruction. The executor therefore drives the Gateway exactly as the Updater
 * does — including the parts that can refuse it, like a backend switch outside
 * maintenance.
 *
 * Shared with the restart stage, which needs the same channel for a single
 * `status` read: the Updater asks the Gateway which Server it is routing to
 * before it reconciles, so a restart driven against a different channel would
 * not be the one production takes.
 */
function gatewayController(managedRoot: string) {
  return {
    status: () => gatewayCall<ManagedGatewayStatus>({ method: 'status' }),
    enterMaintenance: async (): Promise<void> => {
      await gatewayCall({ method: 'enterMaintenance' });
    },
    leaveMaintenance: async (): Promise<void> => {
      await gatewayCall({ method: 'leaveMaintenance' });
    },
    drain: async (timeoutMs: number): Promise<void> => {
      const drained = await gatewayControl<{ forced: number }>({ method: 'drain', timeoutMs });
      // What the Updater discards and this smoke exists to see: how many
      // connections were still there when the window closed, and how long it
      // took to get there. Recorded on the driver's own filesystem, because
      // the stage that asserts on it is a later process (ADR 0008's "forced
      // close at the timeout").
      await recordDrain(managedRoot, {
        timeoutMs,
        forced: drained.value.forced,
        // Timed around the drain call inside the control container, not around
        // the container. The forced case asserts the window was used up, so an
        // elapsed time padded by a container start would let a Gateway that
        // closed early pass as one that waited.
        elapsedMs: drained.elapsedMs,
      });
    },
    switchBackend: async (host: string): Promise<void> => {
      await gatewayCall({
        method: 'switchBackend',
        backend: { host, publicPort: 8082, internalPort: 8083 },
      });
    },
  };
}

async function cutoverDeps(
  managedRoot: string,
  options: {
    readonly probeUrl?: string;
    readonly readinessTimeoutMs: number;
    readonly rollbackReadinessTimeoutMs?: number;
    readonly standby?: StandbyExchange;
    readonly standbyTimeoutMs?: number;
    readonly observeTimeoutMs?: number;
    readonly gatewayDrainTimeoutMs?: number;
  },
): Promise<UpdateCutoverDeps> {
  const databaseUrl = required('VERITY_SMOKE_DATABASE_URL');
  const state = await readManagedDeployment(managedRoot);
  if (!state.managed) fail(`managed authority unavailable: ${state.reason}`);
  return dockerStandbyPromotion({
    managedRoot,
    docker: docker(),
    environment: serverEnvironment(databaseUrl, state.spec.deploymentId),
    readFile: readSecret,
    activate: publishActivationGate,
    ...(options.probeUrl === undefined ? {} : { probeUrl: options.probeUrl }),
    // The rollback scenario poisons the CANDIDATE endpoint and shortens its
    // budget to bound a failure it wants. Neither may leak into the proof that
    // the old generation came back: that probe keeps the real health port and
    // the same budget the success scenarios give a starting Server. The one
    // stage that shortens it is the one whose old generation is MEANT to fail
    // this probe, where a long budget only buys wall-clock.
    rollbackProbe: {
      url: DEFAULT_READINESS_PROBE_URL,
      readinessTimeoutMs: options.rollbackReadinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    },
    readinessTimeoutMs: options.readinessTimeoutMs,
    // Absent, `quiesceOld` stops the old container and `activateOld` starts it
    // again — the path a Server from an image that predates the directive gets,
    // and the one `cutover-rolls-back` runs below.
    ...(options.standby === undefined
      ? {}
      : {
          standby: options.standby,
          standbyTimeoutMs: options.standbyTimeoutMs ?? STANDBY_TIMEOUT_MS,
        }),
    observeMs: 3_000,
    // Shortened only by the stages whose candidate is already dead when the
    // window opens, where the full budget buys wall-clock and nothing else.
    observeTimeoutMs: options.observeTimeoutMs ?? 60_000,
    // Only the stage with clients attached shortens this. Everywhere else the
    // Gateway is idle, so a drain returns as soon as it is asked and the budget
    // is never reached — leaving it at the production default keeps every other
    // stage honest about what the Updater really passes.
    ...(options.gatewayDrainTimeoutMs === undefined
      ? {}
      : { gatewayDrainTimeoutMs: options.gatewayDrainTimeoutMs }),
    gateway: gatewayController(managedRoot),
  });
}

/** Drains this run has performed, oldest first, beside the journal. */
const GATEWAY_DRAIN_FILE = 'gateway-drains.json';

interface RecordedDrain {
  readonly timeoutMs: number;
  readonly forced: number;
  readonly elapsedMs: number;
}

async function recordDrain(managedRoot: string, drain: RecordedDrain): Promise<void> {
  const path = join(managedRoot, GATEWAY_DRAIN_FILE);
  const next = [...(await readDrains(managedRoot)), drain];
  await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function readDrains(managedRoot: string): Promise<readonly RecordedDrain[]> {
  try {
    return JSON.parse(
      await readFile(join(managedRoot, GATEWAY_DRAIN_FILE), 'utf8'),
    ) as RecordedDrain[];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Assert that the outgoing Server gave the control plane up without being
 * stopped — which is the whole of ADR 0008 D9 and the only thing that separates
 * a standby from the fallback.
 *
 * Checked inside `quiesceOld` rather than after the run, because the evidence
 * does not survive the phase: a cutover that fell back to stopping the container
 * starts it again on rollback and removes it on commit, so by the time either
 * settles both paths look alike.
 */
function quiescedNotStopped(
  deps: UpdateCutoverDeps,
  standby: SmokeStandby,
  client: DockerClient,
): UpdateCutoverDeps {
  return {
    ...deps,
    quiesceOld: async (state) => {
      await deps.quiesceOld(state);
      // A publish that threw would leave the request unread, the wait would time
      // out, and the cutover would stop the container and carry on — a passing
      // run that proved the opposite of what this stage is for.
      expect(
        standby.failures.length === 0,
        `publishing the standby request failed: ${String(standby.failures[0])}`,
      );
      expect(
        standby.exchange.acknowledged(generationOperationId(state.candidateGeneration)) ===
          'quiesced',
        'the outgoing Server never acknowledged the quiesce, so its container was stopped instead',
      );
      const old = await client.inspectContainer(state.oldContainerId);
      expect(old.running, 'the outgoing Server was stopped rather than quiesced');
    },
  };
}

/**
 * The failure path, and the one worth proving on a real daemon: a generation
 * that never answers must give the old one back.
 *
 * The verdict is forced by pointing the readiness probe at a port nothing
 * serves, not by shortening its budget — a tight timeout would make the outcome
 * depend on how fast the runner starts a container, and a flaky rollback test is
 * worse than none. Everything ahead of the probe still happens for real: the old
 * process is stopped, the sealed authority is advanced, and the prepared target
 * generation activates. Rollback must restart the retained old container and
 * forward-fence the failed candidate.
 */
async function cutoverRollsBack(managedRoot: string): Promise<void> {
  const previousDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const deps = await cutoverDeps(managedRoot, {
    probeUrl: 'http://verity-managed-server:8099/healthz',
    readinessTimeoutMs: UNSERVED_TIMEOUT_MS,
  });
  let raised: unknown;
  try {
    await resumeUpdateCutover(deps);
  } catch (error) {
    raised = error;
  }
  if (!(raised instanceof CandidateReadinessError))
    fail(`expected a candidate readiness failure, got ${String(raised)}`);
  // The probe's own verdict, read back off its logs: proof the exit code came
  // from the shipped entrypoint deciding, not from a container that failed to
  // start and happened to exit non-zero.
  expect(
    raised.diagnostics.includes('"ok":false'),
    `readiness failure carried no probe verdict: ${raised.diagnostics}`,
  );

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'rolled-back', `journal settled in ${String(journal?.phase)}`);
  expect(
    journal?.targetDigest === targetDigest,
    `the rolled-back operation targeted ${String(journal?.targetDigest)}`,
  );

  // The sealed authority is what every later reconcile rebuilds from, so it has
  // to be back on the old digest — otherwise the next Updater start would
  // quietly re-apply the update that just failed.
  const state = await readManagedDeployment(managedRoot);
  if (!state.managed) fail(`managed authority unavailable after rollback: ${state.reason}`);
  expect(state.spec.image === previousDigest, `authority kept ${state.spec.image}`);

  const client = docker();
  const server = await managedServer(client);
  expect(server.running, 'restored Server is not running');
  expect(server.image === previousDigest, `restored Server runs ${String(server.image)}`);
  await expectNoScaffolding(client, 'rollback');
  process.stdout.write(`rolled back to ${previousDigest} after a failed readiness probe\n`);
}

/**
 * The same failure, on a Server that answers the directive (ADR 0008 D7/D9).
 *
 * `cutover-rolls-back` above runs without a relay, so the exchange has nowhere
 * to live and the cutover falls back to what it did before standbys existed:
 * stop the container, start it again. That path has to keep working — a Server
 * from an image predating the directive never answers — but it is not the one
 * the ADR is about, and its cost is visible in the smoke's own assertions, where
 * the restored generation comes back sealed.
 *
 * This stage is the other half. The relay is up and owns the run's exchange, so
 * the outgoing Server is asked instead of stopped, and the rollback returns to a
 * process that never died: same container, same start time, same unlocked key.
 * The candidate is failed exactly as above, by a probe pointed at a port nothing
 * serves, so the only difference between the two runs is whether there was a
 * standby to answer.
 */
async function cutoverRollsBackOntoStandby(managedRoot: string): Promise<void> {
  const previousDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const client = docker();
  const before = await managedServer(client);
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));
  try {
    const deps = await cutoverDeps(managedRoot, {
      probeUrl: 'http://verity-managed-server:8099/healthz',
      readinessTimeoutMs: UNSERVED_TIMEOUT_MS,
      standby: standby.exchange,
    });
    let raised: unknown;
    try {
      await resumeUpdateCutover(quiescedNotStopped(deps, standby, client));
    } catch (error) {
      raised = error;
    }
    if (!(raised instanceof CandidateReadinessError))
      fail(`expected a candidate readiness failure, got ${String(raised)}`);

    const journal = await readUpdateJournal(managedRoot);
    if (journal === null) fail('the rolled-back operation left no journal');
    expect(journal.phase === 'rolled-back', `journal settled in ${journal.phase}`);
    const authority = await readManagedDeployment(managedRoot);
    if (!authority.managed)
      fail(`managed authority unavailable after rollback: ${authority.reason}`);
    expect(authority.spec.image === previousDigest, `authority kept ${authority.spec.image}`);

    // Asked for, not inferred: `activateOld` only skips the container start when
    // the standby says it serves again, so a `serving` acknowledgement is the
    // one signal that separates a resumed process from a restarted one.
    expect(
      standby.exchange.acknowledged(generationOperationId(journal.generation)) === 'serving',
      'the standby never reported serving again, so the rollback restarted its container',
    );
    expect(
      standby.failures.length === 0,
      `publishing the standby state failed: ${String(standby.failures[0])}`,
    );

    const after = await managedServer(client);
    expect(after.running, 'the restored Server is not running');
    expect(after.id === before.id, 'the standby was replaced rather than resumed');
    expect(after.image === previousDigest, `restored Server runs ${String(after.image)}`);
    await expectNoScaffolding(client, 'standby rollback');
    process.stdout.write(
      `rolled back onto the quiesced generation without restarting ${before.id}\n`,
    );
  } finally {
    standby.stop();
  }
}

/**
 * An exchange that carries the quiesce and swallows every request to serve
 * again — the standby whose resume does not land inside the window.
 *
 * The Server is real and quiesced for real; what fails is the half of the
 * exchange that would have told it to come back. That is one of the three
 * reasons {@link awaitStandby} resolves `false`, and the only one whose Server
 * is still alive when it does: a directive that never arrives, an
 * acknowledgement lost on the way, and a Server too slow to answer are the same
 * event to a cutover, and it must act on the container in all three.
 *
 * `requested` deliberately keeps reporting the quiesce. That is what the Updater
 * would still be holding — nothing withdrew it — and it is what makes the
 * cutover treat "running" as inconclusive rather than as proof the old Server
 * can take traffic again.
 */
function withheldServing(exchange: StandbyExchange): StandbyExchange {
  return {
    ...exchange,
    request: (operationId, directive) => {
      if (directive !== 'serving') exchange.request(operationId, directive);
    },
  };
}

/**
 * A standby that quiesced and does not come back (ADR 0008 D7/D9).
 *
 * The ADR's claim is that this costs nothing beyond the fallback: "a standby
 * that answered but does not serve fails the probe, is stopped, and leaves the
 * next recovery attempt the cold start it would have done anyway". Every
 * sentence of that is a live property — the probe runs in its own container
 * against a process that really has closed its listeners — and none of it is
 * reachable with an injected `DockerClient`, which has no listeners to close.
 *
 * The candidate is failed the way the other rollback stages fail it, so the only
 * thing this stage varies is whether the resume lands. It leaves the operation
 * mid-rollback on purpose: `activateOld` stops the Server it could not bring
 * back, which is what makes {@link cutoverRecoversRollback} a cold start rather
 * than a retry of the same wait.
 */
async function cutoverStandbyFailsToResume(managedRoot: string): Promise<void> {
  const previousDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const client = docker();
  const before = await managedServer(client);
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));
  try {
    const deps = await cutoverDeps(managedRoot, {
      probeUrl: 'http://verity-managed-server:8099/healthz',
      readinessTimeoutMs: UNSERVED_TIMEOUT_MS,
      rollbackReadinessTimeoutMs: UNSERVED_TIMEOUT_MS,
      standby: withheldServing(standby.exchange),
      standbyTimeoutMs: WITHHELD_STANDBY_TIMEOUT_MS,
    });
    let raised: unknown;
    try {
      await resumeUpdateCutover(quiescedNotStopped(deps, standby, client));
    } catch (error) {
      raised = error;
    }
    // Both halves failed, and the aggregate is how the cutover says so: the
    // candidate was never ready, and the rollback could not put the old
    // generation back either. A plain readiness error here would mean the
    // rollback succeeded, which is the outcome this stage exists to prevent.
    if (!(raised instanceof AggregateError))
      fail(`expected a failed cutover AND a failed rollback, got ${String(raised)}`);
    expect(
      raised.errors.every((error: unknown) => error instanceof CandidateReadinessError),
      `unexpected failure inside the aggregate: ${raised.errors.map(String).join('; ')}`,
    );
    expect(
      standby.failures.length === 0,
      `publishing the standby state failed: ${String(standby.failures[0])}`,
    );

    const journal = await readUpdateJournal(managedRoot);
    expect(
      journal?.phase === 'rollback-activating-old',
      `journal settled in ${String(journal?.phase)}`,
    );
    // Advanced before the probe ran, so the authority is already back on the old
    // digest even though the rollback did not finish. That ordering is what lets
    // the recovery below be a plain resume rather than a repair.
    const authority = await readManagedDeployment(managedRoot);
    if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
    expect(authority.spec.image === previousDigest, `authority kept ${authority.spec.image}`);

    const old = await client.inspectContainer(before.id);
    expect(
      !old.running,
      'the standby that failed to resume was left running, so the Gateway could be routed at a process holding no listeners',
    );
    process.stdout.write(
      `stopped ${before.id} after it quiesced and did not come back inside the window\n`,
    );
  } finally {
    standby.stop();
  }
}

/**
 * Finish the rollback the stage above could not, the way the Updater's next
 * start would (ADR 0008 D7/D9).
 *
 * Deliberately without a standby exchange: the Server this resumes is stopped,
 * so there is nothing to ask, and the cutover has to reach the same conclusion
 * from the container alone. What it does then is the cold start the fallback
 * always did — same container, new process — which is the cost the ADR names for
 * a resume that fails, and the reason the store comes back sealed.
 */
async function cutoverRecoversRollback(managedRoot: string): Promise<void> {
  const previousDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const client = docker();
  const before = await managedServer(client);
  expect(!before.running, 'this stage recovers a stopped Server; it is running');

  const state = await resumeUpdateCutover(
    await cutoverDeps(managedRoot, { readinessTimeoutMs: READINESS_TIMEOUT_MS }),
  );
  expect(state.phase === 'rolled-back', `the resumed rollback settled in ${state.phase}`);

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'rolled-back', `journal settled in ${String(journal?.phase)}`);
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
  expect(authority.spec.image === previousDigest, `authority kept ${authority.spec.image}`);

  const after = await managedServer(client);
  expect(after.running, 'the recovered Server is not running');
  expect(after.id === before.id, 'the recovery built a new container instead of starting the old');
  expect(after.image === previousDigest, `recovered Server runs ${String(after.image)}`);
  await expectNoScaffolding(client, 'rollback recovery');
  process.stdout.write(`recovered the rollback by cold-starting ${before.id}\n`);
}

/**
 * The store this deployment runs on, by the name the driver gives it and the
 * Server reaches it under on `verity-net`.
 */
const POSTGRES_NAME = 'verity-postgres';

async function postgresContainer(client: DockerClient): Promise<string> {
  const found = (await client.listContainers!()).find((item) =>
    item.names?.includes(POSTGRES_NAME),
  );
  if (found === undefined) fail(`this deployment's database container ${POSTGRES_NAME} is gone`);
  return found.id;
}

/**
 * The database taken away in the window an update cannot back out of cheaply
 * (ADR 0008's "database unavailable" gate, after activation).
 *
 * Preflight covers the same failure before an update starts, and refuses. This
 * is the half after: the old generation has already been fenced and quiesced,
 * the key is already sealed for the successor, and the store both generations
 * depend on goes away between the handoff and the candidate's first connection.
 * Nothing in the update path notices directly — the journal is a file, the
 * authority is a file, and `/healthz` never touches the database — so what has to
 * carry the failure is the readiness probe, and what has to survive it is the
 * durable intent behind the rollback.
 *
 * The cut lands inside `activateCandidate`, before the container is created,
 * because that is the only placement with one outcome. Cutting it afterwards
 * races the candidate's boot: a Server that got its connection first answers
 * `/healthz` for as long as it lives, so the same stage would sometimes roll
 * back and sometimes commit. That later window is a real one, and deliberately
 * not this stage's — an update that commits onto a healthy Server and then loses
 * the store leaves a deployment no worse than the store took away by itself.
 *
 * What follows is forced, and the point: the standby holds no control plane, so
 * it survives the loss and then cannot resume — `claimControlPlane` needs the
 * database it is being asked to come back on — and the cold start behind the
 * fallback cannot come up either. Both halves therefore fail, the aggregate says
 * so, and the operation stays parked in `rollback-activating-old` with its
 * authority already back on the old digest. That is the durable intent the ADR
 * asks for: nothing committed, nothing lost, and a rollback that any later
 * attempt can finish once the store is back — which is what
 * {@link cutoverRecoversRollback} then does, from the same container.
 */
async function cutoverLosesTheDatabase(managedRoot: string): Promise<void> {
  const previousDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const client = docker();
  const before = await managedServer(client);
  const routedBefore = (await routedBackend()).host;
  const postgres = await postgresContainer(client);
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));
  try {
    const deps = quiescedNotStopped(
      await cutoverDeps(managedRoot, {
        // Both budgets are the failing kind. The candidate can never answer, and
        // neither can the generation the rollback goes back to, so every second
        // above the bound is wall-clock spent waiting for a process that is not
        // there. The probes still run for real, against the real health port —
        // nothing here poisons an endpoint, because the database is the failure.
        readinessTimeoutMs: UNSERVED_TIMEOUT_MS,
        rollbackReadinessTimeoutMs: UNSERVED_TIMEOUT_MS,
        standby: standby.exchange,
        standbyTimeoutMs: WITHHELD_STANDBY_TIMEOUT_MS,
      }),
      standby,
      client,
    );
    let raised: unknown;
    try {
      await resumeUpdateCutover({
        ...deps,
        activateCandidate: async (state) => {
          await client.stopContainer(postgres);
          const stopped = await client.inspectContainer(postgres);
          expect(!stopped.running, 'the database this stage takes away is still running');
          await deps.activateCandidate(state);
        },
      });
    } catch (error) {
      raised = error;
    }
    if (!(raised instanceof AggregateError))
      fail(`expected a failed cutover AND a failed rollback, got ${String(raised)}`);
    expect(
      raised.errors.every((error: unknown) => error instanceof CandidateReadinessError),
      `unexpected failure inside the aggregate: ${raised.errors.map(String).join('; ')}`,
    );
    expect(
      standby.failures.length === 0,
      `publishing the standby state failed: ${String(standby.failures[0])}`,
    );

    // Parked mid-rollback rather than settled: `failed` would mean the update
    // gave up on putting the old generation back, and `rolled-back` would mean
    // it managed to — with no database, neither can be true.
    const journal = await readUpdateJournal(managedRoot);
    expect(
      journal?.phase === 'rollback-activating-old',
      `journal settled in ${String(journal?.phase)}`,
    );
    const authority = await readManagedDeployment(managedRoot);
    if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
    expect(authority.spec.image === previousDigest, `authority kept ${authority.spec.image}`);

    // The route never moved, so nothing a client can reach was ever pointed at
    // the generation that could not connect.
    expect(
      (await routedBackend()).host === routedBefore,
      `the Gateway was switched to ${(await routedBackend()).host} by a cutover that never became ready`,
    );

    // The standby did not survive being asked to come back, which is the whole
    // of this gate: the generation a rollback returns to needs the same store
    // the candidate could not reach, so there is nothing left to route at and
    // the cutover has to leave the container stopped rather than serving.
    const old = await client.inspectContainer(before.id);
    expect(
      !old.running,
      'the standby that could not reclaim the control plane was left running, so the Gateway could be routed at a process holding none',
    );
    process.stdout.write(
      `left ${before.id} stopped and the rollback unfinished after the store went away\n`,
    );
  } finally {
    standby.stop();
  }
}

/**
 * Ends a stage at the point a real Updater's process would have died.
 *
 * Distinguished from every other failure because this stage has to tell them
 * apart: a cutover that threw on its own would leave the same journal phase, and
 * asserting on the phase alone would pass for the wrong reason.
 */
class SmokeUpdaterCrash extends Error {}

/**
 * The one directive the journal cannot express, lost the way it is meant to be
 * (ADR 0008 D9).
 *
 * `quiescing-old` is journalled before the Gateway drains, so within that phase
 * the quiesce is asked for explicitly — and that request lives only in the
 * Updater's memory. The ADR's claim is that losing it is safe in the only
 * direction that matters: "an Updater that crashes here comes back to a phase
 * that reads as `serving`, so a standby resumes, and the resumed cutover drains
 * and asks again."
 *
 * This stage takes that apart into the two halves the smoke actually has. The
 * executor half really dies — the cutover is this process, and it exits here —
 * and the listener half is made to forget by a refresh that publishes no
 * request, which is the `discard` the control boundary performs when it closes.
 * What is left is a Server that was quiesced by a request nobody holds any more,
 * in front of a listener deriving its directive from a phase that reads
 * `serving`. The driver then watches it serve again, as the same process, and
 * runs the commit — which is the resumed cutover asking a second time.
 */
async function cutoverLosesTheRequest(managedRoot: string): Promise<void> {
  const client = docker();
  const before = await managedServer(client);
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));
  let raised: unknown;
  try {
    const deps = quiescedNotStopped(
      await cutoverDeps(managedRoot, {
        readinessTimeoutMs: READINESS_TIMEOUT_MS,
        standby: standby.exchange,
      }),
      standby,
      client,
    );
    await resumeUpdateCutover({
      ...deps,
      // After the real quiesce, not instead of it: the point is a request that
      // was made, answered, and then lost, which is the only sequence that can
      // leave a quiesced Server with nobody asking anything of it.
      quiesceOld: async (state) => {
        await deps.quiesceOld(state);
        throw new SmokeUpdaterCrash('the Updater died holding the only copy of its request');
      },
    });
  } catch (error) {
    raised = error;
  } finally {
    standby.stop();
  }
  if (!(raised instanceof SmokeUpdaterCrash))
    fail(`expected the simulated Updater crash, got ${String(raised)}`);

  const journal = await readUpdateJournal(managedRoot);
  // No rollback, and that is the contract: a cutover that fails at or before
  // `quiescing-old` has not touched the candidate, so it rethrows and leaves the
  // operation resumable rather than spending a generation on a rollback.
  expect(journal?.phase === 'quiescing-old', `journal settled in ${String(journal?.phase)}`);
  const old = await client.inspectContainer(before.id);
  expect(old.running, 'the crash left the outgoing Server stopped rather than quiesced');
  process.stdout.write(`lost the quiesce request for ${before.id} in ${String(journal?.phase)}\n`);
}

/**
 * The four moments ADR 0008's acceptance gate names for a `SIGKILL`, and the
 * journal phase each one parks the operation in.
 *
 * Delivering the signal is the driver's job, not this process's. Partly because
 * the harness holds no kill — but mostly because a cutover that shot its own
 * Server would be proving something about this file. The container has to be
 * killed from outside the update, by something that knows nothing about it,
 * which is what `docker kill` in the driver is. So a halt stage drives the real
 * cutover to the phase in question, names the container the kill belongs to, and
 * exits where a real Updater's process would have.
 */
const HALT_POINTS = {
  /** The old Server has quiesced and acknowledged; the window is open. */
  quiesced: 'handing-off-key',
  /** The candidate has claimed its generation and holds the session lock. */
  activating: 'activating-candidate',
  /** The Gateway has been pointed at the candidate. */
  switching: 'switching-gateway',
  /** The candidate passed readiness and the stabilization window is open. */
  observing: 'observing-candidate',
} as const;

type HaltPoint = keyof typeof HALT_POINTS;

function haltPoint(value: string | undefined): HaltPoint {
  if (value !== undefined && Object.hasOwn(HALT_POINTS, value)) return value as HaltPoint;
  fail(`unknown halt point: ${String(value)}`);
}

/**
 * Drive a real cutover to one of the {@link HALT_POINTS} and stop there.
 *
 * The stage runs with the standby wired and `quiescedNotStopped` around it, so
 * every halt is reached across a window a live Server really quiesced for —
 * which is what makes the kill that follows a kill of a standby, or of a
 * candidate that took the control plane from one, rather than of a container.
 *
 * Throwing out of a callback would be the wrong halt: the cutover has a handler
 * for that, and it is a good one — it rolls the operation back and leaves the
 * journal in `rolled-back`, which is the opposite of the state a killed Updater
 * leaves behind. So the halt takes the journal away instead. From the moment it
 * fires, every read and every transition raises, exactly as they would for a
 * process that no longer exists: the rollback the executor tries to start cannot
 * read the phase it would roll back from, and nothing more is written. What the
 * next process finds is therefore the phase this one was in when it died, which
 * is the only durable thing a `SIGKILL` leaves.
 *
 * The lease is the one difference from a real kill, and it goes the harder way:
 * this process releases it on the way out, where a killed one would leave it to
 * be crash-released. A resume that only works against a cleanly released lease
 * would still pass here — but the stages that resume are separate processes
 * either way, and the crash-release path is what every other stage in this file
 * already exercises by exiting mid-operation.
 */
async function cutoverHaltsAt(managedRoot: string, point: HaltPoint): Promise<void> {
  const client = docker();
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));
  let target: string | undefined;
  let raised: unknown;
  let dead = false;
  try {
    const deps = quiescedNotStopped(
      await cutoverDeps(managedRoot, {
        readinessTimeoutMs: READINESS_TIMEOUT_MS,
        standby: standby.exchange,
      }),
      standby,
      client,
    );
    const crash = (): never => {
      throw new SmokeUpdaterCrash(`the Updater stopped in ${HALT_POINTS[point]}`);
    };
    const halt = (state: CutoverState): never => {
      target = point === 'quiesced' ? state.oldContainerId : state.candidateContainerId;
      dead = true;
      return crash();
    };
    await resumeUpdateCutover({
      ...deps,
      store: {
        runExclusive: deps.store.runExclusive,
        read: async () => (dead ? crash() : deps.store.read()),
        transition: async (expected, next) =>
          dead ? crash() : deps.store.transition(expected, next),
      },
      // Before the step for the points whose work must NOT have happened, after
      // it for the ones whose whole claim is that it did. A candidate killed
      // during activation has to have claimed its generation first, or the
      // restart that follows would prove nothing about the lock that claim took;
      // a candidate killed during verification has to have passed readiness
      // first, or the window would be catching a Server that never served.
      ...(point === 'quiesced' ? { handoffKey: halt } : {}),
      ...(point === 'activating'
        ? {
            activateCandidate: async (state: CutoverState) => {
              await deps.activateCandidate(state);
              halt(state);
            },
          }
        : {}),
      ...(point === 'switching'
        ? {
            switchGatewayToCandidate: async (state: CutoverState) => {
              await deps.switchGatewayToCandidate(state);
              halt(state);
            },
          }
        : {}),
      ...(point === 'observing' ? { observeCandidate: halt } : {}),
    });
  } catch (error) {
    raised = error;
  } finally {
    standby.stop();
  }
  if (!(raised instanceof SmokeUpdaterCrash))
    fail(`expected the halt at ${point}, got ${String(raised)}`);
  if (target === undefined) fail(`the cutover never reached the halt at ${point}`);

  const journal = await readUpdateJournal(managedRoot);
  expect(
    journal?.phase === HALT_POINTS[point],
    `the halt at ${point} parked the journal in ${String(journal?.phase)}`,
  );
  // A signal only means something against a process that is running. A container
  // that had already exited would let every assertion after the kill pass for a
  // reason this stage never established.
  expect(
    (await client.inspectContainer(target)).running,
    `the container to kill at ${point} is not running`,
  );
  process.stdout.write(`kill-target ${target}\n`);
}

/**
 * A candidate SIGKILLed while it held its generation must be able to take it
 * again.
 *
 * The one kill in the matrix the update is expected to survive rather than undo.
 * The candidate died holding a PostgreSQL session advisory lock, and ADR 0008's
 * claim is that this costs nothing, because the lock is not a lease: PostgreSQL
 * "releases it atomically on a process, socket, or database failure". Nothing in
 * the Updater cleans up after a killed generation, so if that were wrong the
 * restarted candidate would wait behind its own corpse and fail readiness —
 * which is the failure this stage would report.
 *
 * The recovery is a restart and not a rebuild: `activateCandidate` is idempotent
 * and starts the container it already has, so the generation that commits has to
 * be the same container that was killed.
 */
async function cutoverSurvivesActivationKill(managedRoot: string): Promise<void> {
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const client = docker();
  const candidateId = (await readUpdateJournal(managedRoot))?.candidate?.containerId;
  if (candidateId === undefined) fail('the activation kill needs a prepared candidate');
  expect(
    !(await client.inspectContainer(candidateId)).running,
    'this stage resumes a killed candidate; it is still running',
  );

  const state = await resumeUpdateCutover(
    await cutoverDeps(managedRoot, { readinessTimeoutMs: READINESS_TIMEOUT_MS }),
  );
  expect(state.phase === 'committed', `the resumed cutover settled in ${state.phase}`);

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'committed', `journal settled in ${String(journal?.phase)}`);
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
  expect(authority.spec.image === targetDigest, `authority kept ${authority.spec.image}`);

  const after = await managedServer(client);
  expect(after.id === candidateId, 'the resume built a new candidate instead of restarting one');
  expect(after.running, 'the restarted candidate is not running');
  expect(after.image === targetDigest, `the restarted candidate runs ${String(after.image)}`);
  await expectNoScaffolding(client, 'the activation kill');
  process.stdout.write(`committed ${candidateId} after a SIGKILL during activation\n`);
}

/**
 * A candidate that dies after the Gateway has been pointed at it, or inside the
 * stabilization window that follows.
 *
 * Both halts leave the same wreckage — a route selection naming a process that
 * no longer exists — and ADR 0008 answers both the same way: the observation
 * window is a real re-probe rather than a sleep, so it catches a generation that
 * passed readiness and then died, and the operation goes back. What this adds
 * over the probe failures already covered is that nothing here failed to start.
 * The earlier stages fail a candidate that never served; this one killed a
 * candidate that was serving, which is the only version of the failure that can
 * happen after the Gateway has committed traffic to it.
 *
 * The standby is wired because the recovery has to be the warm one: the outgoing
 * Server has been quiesced since the halt, and `activateOld` must ask it back
 * rather than restart it. The driver checks that from outside, on the process.
 *
 * The generation to come back to is read from the journal rather than from the
 * Gateway, which is the point of the stage: the Gateway is pointed at the dead
 * candidate when this starts, and asserted to be, so a rollback that left the
 * route where it found it would fail here rather than pass quietly.
 */
async function cutoverRollsBackAfterKill(managedRoot: string): Promise<void> {
  const client = docker();
  const journalBefore = await readUpdateJournal(managedRoot);
  const standbyId = journalBefore?.previousContainerId;
  const candidateId = journalBefore?.candidate?.containerId;
  if (
    journalBefore === null ||
    standbyId === undefined ||
    standbyId === null ||
    candidateId === undefined
  )
    fail('the kill past readiness needs a prepared candidate and a recorded predecessor');
  // The generation to come back to, read off the journal rather than off the
  // run's bootstrap digest: these stages run AFTER a commit, so what this
  // operation started from is the image that commit installed — the target the
  // earlier generations moved to, not the one the deployment was adopted on.
  // Naming the bootstrap digest here would assert that a successful update had
  // been undone.
  const previousDigest = journalBefore.previousDigest;
  expect(
    !(await client.inspectContainer(candidateId)).running,
    'this stage rolls back from a killed candidate; it is still running',
  );
  const routed = (await routedBackend()).host;
  const candidateName = serverName(
    (await client.listContainers!()).find((item) => item.id === candidateId)?.names,
  );
  expect(
    routed === candidateName,
    `the Gateway is routed to ${routed} rather than the killed candidate`,
  );
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));
  let raised: unknown;
  try {
    await resumeUpdateCutover(
      await cutoverDeps(managedRoot, {
        // Both budgets are the short one: this candidate is already dead when
        // the window opens, so a full budget buys wall-clock and nothing else.
        readinessTimeoutMs: UNSERVED_TIMEOUT_MS,
        observeTimeoutMs: UNSERVED_TIMEOUT_MS,
        standby: standby.exchange,
      }),
    );
  } catch (error) {
    raised = error;
  } finally {
    standby.stop();
  }
  if (!(raised instanceof CandidateReadinessError))
    fail(`expected the killed candidate to fail its probe, got ${String(raised)}`);

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'rolled-back', `journal settled in ${String(journal?.phase)}`);
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
  expect(authority.spec.image === previousDigest, `authority kept ${authority.spec.image}`);

  const after = await managedServer(client);
  expect(after.id === standbyId, 'the rollback left traffic on something other than the standby');
  expect(after.running, 'the resumed standby is not running');
  expect(after.image === previousDigest, `the resumed standby runs ${String(after.image)}`);
  await expectNoScaffolding(client, 'the kill past readiness');
  process.stdout.write(`rolled back onto ${standbyId} after a SIGKILL past readiness\n`);
}

/**
 * The standby dies inside the window it exists to hold open (ADR 0008 D8/D9).
 *
 * The quiesced Server is the one thing the maintenance window keeps alive, so
 * the obvious fear is that killing it strands the update: the incoming
 * generation takes its key from the outgoing one, and there is now no outgoing
 * one to ask. The ordering is what makes it survivable — the handoff "completed
 * before `quiescing-old` stopped the process that held the key", so by the time
 * there is a standby to kill, the envelope it was going to hand over has already
 * been sealed and published to the mailbox.
 *
 * The forward path therefore owes nothing to the process that died, and the
 * assertion worth having is the driver's: the committed generation comes up
 * unlocked even though the Server it inherited from was SIGKILLed before it
 * could be retired.
 */
async function cutoverCommitsWithoutTheStandby(managedRoot: string): Promise<void> {
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const client = docker();
  const journal = await readUpdateJournal(managedRoot);
  const candidateId = journal?.candidate?.containerId;
  const killedId = journal?.previousContainerId;
  if (candidateId === undefined || killedId === undefined || killedId === null)
    fail('the standby kill needs a prepared candidate and a recorded predecessor');
  expect(
    !(await client.inspectContainer(killedId)).running,
    'this stage commits over a killed standby; it is still running',
  );

  const state = await resumeUpdateCutover(
    await cutoverDeps(managedRoot, { readinessTimeoutMs: READINESS_TIMEOUT_MS }),
  );
  expect(state.phase === 'committed', `the resumed cutover settled in ${state.phase}`);

  const settled = await readUpdateJournal(managedRoot);
  expect(settled?.phase === 'committed', `journal settled in ${String(settled?.phase)}`);
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
  expect(authority.spec.image === targetDigest, `authority kept ${authority.spec.image}`);

  const after = await managedServer(client);
  expect(after.id === candidateId, 'the commit promoted a container it never prepared');
  expect(after.running, 'the committed generation is not running');
  expect(after.image === targetDigest, `the committed generation runs ${String(after.image)}`);
  // Retirement is best-effort cleanup after a durable commit, and a killed
  // container is exactly the case where "best effort" could quietly mean none:
  // the commit must remove a corpse as readily as a running predecessor.
  const remaining = (await client.listContainers!()).map((item) => item.id);
  expect(!remaining.includes(killedId), 'the commit left the killed standby behind');
  await expectNoScaffolding(client, 'the standby kill');
  process.stdout.write(`committed ${candidateId} over a SIGKILLed standby\n`);
}

/**
 * Refresh the relay's copy of the journal without asking for anything.
 *
 * A relay outlives the operation it was started for — it is the run's whole
 * control boundary, not one cutover's — so a generation prepared after it
 * started would otherwise be invisible to it. Two things make that matter. The
 * mailbox binds an envelope to the journal the listener can see, so an outgoing
 * Server sealing against a stale binding hands the next generation material it
 * cannot open and the commit comes up at a password prompt. And the directive is
 * published under the journal's own generation, so a Server polling for one
 * about `generation-<n>` hears nothing while the listener is still talking about
 * its predecessor.
 *
 * Asking for nothing is the second half of the job, not an absence of one: a
 * refresh publishes no request, so the listener drops whatever it was holding
 * and falls back to the phase. That is what retires a quiesce whose cutover is
 * gone — see {@link cutoverLosesTheRequest} — and what keeps a Server the next
 * stage starts from quiescing itself on an answer to a question nobody is
 * asking any more.
 */
async function relayJournal(managedRoot: string): Promise<void> {
  const journal = await readUpdateJournal(managedRoot);
  if (journal === null || journal.candidate === null)
    fail('the relay journal refresh needs a prepared candidate');
  await publishStandbyState(managedRoot, null);
  process.stdout.write(`relay journal refreshed to generation ${String(journal.generation)}\n`);
}

/**
 * The success path: the running Server is replaced under its own name by the
 * target digest, and the operation only commits once the new generation has
 * answered `/healthz` from inside `verity-net` and kept answering.
 *
 * Driven over the standby exchange as well, so the generation that commits is
 * one that took the control plane from a process rather than from a stopped
 * container — which is also what lets the key handoff happen at all: the Server
 * being replaced is still alive, holding its key, when the candidate asks.
 */
async function cutoverCommits(managedRoot: string): Promise<void> {
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const client = docker();
  const before = await managedServer(client);
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));

  // Stopped in a `finally`, because its poll is an unreffed-nothing: an interval
  // left running holds the event loop open, so a stage that failed would hang
  // until the workflow's own timeout instead of reporting why.
  let state;
  try {
    state = await resumeUpdateCutover(
      quiescedNotStopped(
        await cutoverDeps(managedRoot, {
          readinessTimeoutMs: READINESS_TIMEOUT_MS,
          standby: standby.exchange,
        }),
        standby,
        client,
      ),
    );
  } finally {
    standby.stop();
  }
  expect(state.phase === 'committed', `cutover settled in ${state.phase}`);
  expect(
    standby.failures.length === 0,
    `publishing the standby state failed: ${String(standby.failures[0])}`,
  );

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'committed', `journal settled in ${String(journal?.phase)}`);
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable after cutover: ${authority.reason}`);
  expect(authority.spec.image === targetDigest, `authority kept ${authority.spec.image}`);

  const after = await managedServer(client);
  expect(after.running, 'new generation is not running');
  expect(after.image === targetDigest, `new generation runs ${String(after.image)}`);
  expect(after.id !== before.id, 'the Server container was never replaced');
  await expectNoScaffolding(client, 'cutover');

  // Resume on a committed operation is what the Updater does on every start for
  // the rest of that journal's life. It must read the terminal phase and stop,
  // not replay the replacement it already performed. No standby is wired in:
  // there is no old Server left to ask, and a resume that reached for one would
  // be reaching past a container the commit already removed.
  const resumed = await resumeUpdateCutover(
    await cutoverDeps(managedRoot, { readinessTimeoutMs: READINESS_TIMEOUT_MS }),
  );
  expect(resumed.phase === 'committed', `resume moved a committed operation to ${resumed.phase}`);
  expect((await managedServer(client)).id === after.id, 'resume replaced the Server again');
  process.stdout.write(`committed generation ${String(journal?.generation)} on ${targetDigest}\n`);
}

/**
 * Which half of the drain contract the run with clients attached is about. One
 * cutover drains once, so no single generation can show both.
 */
type DrainOutcome = 'released' | 'forced';

/**
 * Budgets for the two client stages. The polite one is the production default
 * (`gatewayDrainTimeoutMs` in `docker-in-place-cutover.ts`), restated here only
 * because the assertion has to know the budget it is measuring against — the
 * claim being made is that a cooperative client costs an update far less than
 * it is allowed to, which is a statement about the window operators really get.
 * Move it with the default if that ever changes. The forced one is short
 * because it is spent in full by definition: it is the wall-clock price of one
 * client that will not let go, and the smoke pays it on every run.
 */
const RELEASED_DRAIN_TIMEOUT_MS = 30_000;
const FORCED_DRAIN_TIMEOUT_MS = 10_000;

/**
 * A commit with real clients on the Gateway — ADR 0008's "existing long-lived
 * WebSockets and in-flight broker requests during Gateway drain, including
 * forced close at the timeout".
 *
 * The client is a separate container the driver starts before this process and
 * waits on after it; it makes its own assertions about what it observed. This
 * side asserts the other half — what the drain reported to the Updater — which
 * no client can see, and which the Updater itself discards.
 */
async function cutoverWithClients(managedRoot: string, outcome: DrainOutcome): Promise<void> {
  const targetDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const drainTimeoutMs =
    outcome === 'released' ? RELEASED_DRAIN_TIMEOUT_MS : FORCED_DRAIN_TIMEOUT_MS;
  const client = docker();
  const before = await managedServer(client);
  // The ledger spans the whole run, so only what this cutover adds to it is this
  // stage's evidence.
  const earlier = (await readDrains(managedRoot)).length;
  const standby = smokeStandbyExchange(managedRoot, await relayContainer(client));

  let state;
  try {
    state = await resumeUpdateCutover(
      quiescedNotStopped(
        await cutoverDeps(managedRoot, {
          readinessTimeoutMs: READINESS_TIMEOUT_MS,
          standby: standby.exchange,
          gatewayDrainTimeoutMs: drainTimeoutMs,
        }),
        standby,
        client,
      ),
    );
  } finally {
    standby.stop();
  }
  expect(state.phase === 'committed', `cutover settled in ${state.phase}`);
  expect(
    standby.failures.length === 0,
    `publishing the standby state failed: ${String(standby.failures[0])}`,
  );

  // Exactly one: a cutover that commits quiesces the old generation once and
  // never drains the candidate, so a second entry would mean a rollback nobody
  // asked for.
  const drains = (await readDrains(managedRoot)).slice(earlier);
  expect(drains.length === 1, `the cutover drained ${String(drains.length)} times`);
  const drain = drains[0]!;
  expect(
    drain.timeoutMs === drainTimeoutMs,
    `the drain ran on a ${String(drain.timeoutMs)}ms budget`,
  );
  if (outcome === 'released') {
    // Nothing was taken away, because there was nothing left to take: the client
    // let go when it was asked to, and the drain saw the counters reach zero.
    expect(
      drain.forced === 0,
      `the drain forced ${String(drain.forced)} connection(s) closed on clients that had let go`,
    );
    // And it cost the update a fraction of what it was allowed. Compared against
    // half the budget rather than a fixed figure, because the measurement
    // includes the control container's start and the claim is only that the
    // drain returned on the clients rather than on its deadline.
    expect(
      drain.elapsedMs < drainTimeoutMs / 2,
      `the drain took ${String(drain.elapsedMs)}ms of a ${String(drainTimeoutMs)}ms budget`,
    );
  } else {
    // The other half: the update is not hostage to a client that ignores it.
    expect(drain.forced >= 1, 'the drain forced nothing closed although a client never let go');
    expect(
      drain.elapsedMs >= drainTimeoutMs,
      `the drain gave up after ${String(drain.elapsedMs)}ms of its ${String(drainTimeoutMs)}ms budget`,
    );
  }

  const journal = await readUpdateJournal(managedRoot);
  expect(journal?.phase === 'committed', `journal settled in ${String(journal?.phase)}`);
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable after cutover: ${authority.reason}`);
  expect(authority.spec.image === targetDigest, `authority kept ${authority.spec.image}`);

  const after = await managedServer(client);
  expect(after.running, 'new generation is not running');
  expect(after.image === targetDigest, `new generation runs ${String(after.image)}`);
  expect(after.id !== before.id, 'the Server container was never replaced');
  await expectNoScaffolding(client, 'cutover');
  process.stdout.write(
    `committed generation ${String(journal?.generation)} on ${targetDigest} ` +
      `(drained ${String(drain.elapsedMs)}ms, forced ${String(drain.forced)})\n`,
  );
}

/**
 * Start the Updater the way its own container start does — `recoverManagedUpdater`
 * is the production entry point, called with nothing this smoke invented.
 *
 * The environment it resolves the sealed `env:` sources against carries the
 * stale `VERITY_SERVER_IMAGE` a real restart would carry. Compose pins one
 * image ref for the Gateway, the Updater and the bootstrap job, and a
 * self-update never rewrites the file, so after this run's commits that
 * variable still names the digest the deployment started on. It is in the
 * Updater's environment and it must reach no container: the Server's image
 * comes from the sealed spec or from nowhere.
 */
async function restartUpdater(managedRoot: string): Promise<void> {
  const state = await readManagedDeployment(managedRoot);
  if (!state.managed) fail(`managed authority unavailable: ${state.reason}`);
  await recoverManagedUpdater({
    managedRoot,
    docker: docker(),
    environment: {
      ...serverEnvironment(required('VERITY_SMOKE_DATABASE_URL'), state.spec.deploymentId),
      VERITY_SERVER_IMAGE: required('VERITY_SMOKE_PREVIOUS_DIGEST'),
    },
    readFile: readSecret,
    cutover: { activate: publishActivationGate, gateway: gatewayController(managedRoot) },
    reconcileCompanions: () => Promise.resolve(),
  });
}

async function companionHandoff(managedRoot: string): Promise<void> {
  const client = docker();
  let journal = await readUpdateJournal(managedRoot);
  if (journal === null) fail('companion handoff needs an update journal');
  const deploymentId = journal.deploymentId;
  const previous = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  const target = required('VERITY_SMOKE_TARGET_DIGEST');
  const createScaffold = async (name: string, service: string, binds: string[] = []) => {
    const existing = (await client.listContainers!()).find(
      (item) => item.labels?.['com.docker.compose.service'] === service,
    );
    if (existing !== undefined) return;
    const created = await client.createContainer({
      image: previous,
      name,
      labels: { 'com.docker.compose.service': service },
      env: [`VERITY_MANAGED_DEPLOYMENT_ID=${deploymentId}`],
      entrypoint: ['sleep'],
      command: ['600'],
      binds,
      network: 'none',
      restartPolicy: 'no',
    });
    await client.startContainer(created.id);
  };
  if (journal.phase === 'committed') {
    journal = await advanceCompanionReconciliation(
      managedRoot,
      'committed',
      'reconciling-companions',
    );
  }
  if (journal.phase === 'reconciling-companions') {
    await createScaffold('verity-smoke-managed-gateway', 'verity-managed-gateway');
    await createScaffold('verity-smoke-agent-gateway', 'verity-agent-gateway');
    await createScaffold('verity-smoke-updater', 'verity-updater', [
      `${required('VERITY_SMOKE_AGENT_SEED_HOST_PATH')}:/opt/agent-seed:ro`,
    ]);

    const handoffStarted = new Error('companion handoff changed process ownership');
    try {
      await reconcileManagedCompanions({
        managedRoot,
        docker: client,
        // These are deliberately passive replacement scaffolds, not real
        // Gateway processes. Omitting the environment keeps the production-only
        // control-socket readiness probe out of this container-lifecycle smoke;
        // the handoff helper still uses its default Docker socket path.
        journal,
        waitForHandoff: async () => {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const updater = (await client.listContainers!()).find(
              (item) => item.labels?.['com.docker.compose.service'] === 'verity-updater',
            );
            if (updater !== undefined) {
              const inspected = await client.inspectContainer(updater.id);
              if (inspected.image === target) throw handoffStarted;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          fail('target-image helper did not replace the Updater');
        },
        reconcileRunner: () => Promise.resolve(),
      });
    } catch (error) {
      if (error !== handoffStarted) throw error;
    }

    let runnerReconciled = false;
    await reconcileManagedCompanions({
      managedRoot,
      docker: client,
      journal,
      reconcileRunner: () => {
        runnerReconciled = true;
        return Promise.resolve();
      },
    });
    expect(runnerReconciled, 'successor Updater did not reconcile the managed Runner');
    journal = await advanceCompanionReconciliation(
      managedRoot,
      'reconciling-companions',
      'completed',
    );
  }
  expect(journal.phase === 'completed', `companion handoff stopped at ${journal.phase}`);
  for (const service of ['verity-managed-gateway', 'verity-agent-gateway', 'verity-updater']) {
    const match = (await client.listContainers!()).find(
      (item) => item.labels?.['com.docker.compose.service'] === service,
    );
    if (match === undefined) fail(`companion ${service} disappeared`);
    const inspected = await client.inspectContainer(match.id);
    expect(inspected.image === target, `${service} stayed on ${String(inspected.image)}`);
  }
  process.stdout.write(`managed companions moved from ${previous} to ${target}\n`);
}

/**
 * ADR 0008's restart gate: "a later managed-deployment restart preserves the
 * selected Server digest rather than reverting to the Compose file's former
 * value."
 *
 * In the managed topology the Server is not a Compose service — the Updater
 * creates it from the Updater-owned sealed spec — so the digest a self-update
 * selected lives only there, while the Compose file keeps naming the one the
 * host was installed with. Every restart after an update therefore starts a
 * Gateway and an Updater from a stale ref, and the question is which of the two
 * the Server follows. `managed-deployment.test.ts` answers the file half of
 * that against a temporary directory. This answers the container half, against
 * the daemon, where a reverted deployment is what an operator would actually
 * see: a host that quietly rolls back its Server on the next reboot.
 *
 * Three restarts, because a host offers three shapes of one and they take
 * different code paths:
 *
 * - the container is stopped but still there (`docker compose stop`, a reboot
 *   with a restart policy that did not fire) — reconciliation must reuse it,
 *   which it only does if the container still matches the sealed spec;
 * - the container is gone (`docker compose down`, a pruned host) — there is
 *   nothing to match, so the spec alone decides what gets built;
 * - the documented adoption job is run again, this time by an operator with the
 *   Compose file's stale variable still exported. That one must refuse rather
 *   than re-seal, and leave the selected digest where it was.
 *
 * The generation identity is asserted across all of them: the Gateway is not
 * restarted here and keeps routing to `verity-managed-server-gN`, so a rebuild
 * that came back under the historical unsuffixed name would be a Server nothing
 * reaches.
 */
async function updaterRestarts(managedRoot: string): Promise<void> {
  const committedDigest = required('VERITY_SMOKE_TARGET_DIGEST');
  const composeDigest = required('VERITY_SMOKE_PREVIOUS_DIGEST');
  expect(
    composeDigest !== committedDigest,
    'the Compose digest and the committed digest are the same image; this stage would prove nothing',
  );
  const authority = await readManagedDeployment(managedRoot);
  if (!authority.managed) fail(`managed authority unavailable: ${authority.reason}`);
  expect(
    authority.spec.image === committedDigest,
    `the sealed spec names ${authority.spec.image} before any restart`,
  );
  const client = docker();
  const routedName = (await routedBackend()).host;
  const before = await managedServer(client);
  expect(
    before.image === committedDigest,
    `the committed generation runs ${String(before.image)}, not the digest the last cutover selected`,
  );

  // An explicit stop, not a kill: `unless-stopped` is exactly the policy that
  // makes the daemon leave it down until someone asks for it, which is the state
  // a restarted Updater has to resolve.
  await client.stopContainer(before.id);
  await restartUpdater(managedRoot);
  const restarted = await managedServer(client);
  expect(
    restarted.id === before.id,
    'the stopped generation was rebuilt instead of started; the container no longer matched the sealed spec',
  );
  expect(restarted.running, 'the stopped generation was not started again');
  expect(
    restarted.image === committedDigest,
    `the restarted generation runs ${String(restarted.image)}`,
  );

  await client.removeContainer(restarted.id);
  await restartUpdater(managedRoot);
  const rebuilt = await managedServer(client);
  expect(rebuilt.id !== restarted.id, 'the removed generation was not rebuilt');
  expect(rebuilt.running, 'the rebuilt generation is not running');
  expect(
    rebuilt.image === committedDigest,
    `the rebuilt generation runs ${String(rebuilt.image)} — the deployment reverted`,
  );
  expect(
    (await routedBackend()).host === routedName,
    'the rebuilt Server took an identity the Gateway is not routing to',
  );
  await expectNoScaffolding(client, 'the restart');

  // The adoption job, re-run with the Compose file's former value — the one
  // documented command an operator can point at a managed root, and the only
  // writer of the sealed spec besides an update.
  const bootstrapEnvironment = {
    ...serverEnvironment(required('VERITY_SMOKE_DATABASE_URL'), authority.spec.deploymentId),
    VERITY_MANAGED_ROOT: managedRoot,
    VERITY_DOCKER_SOCKET_PATH: required('VERITY_SMOKE_DOCKER_SOCKET'),
  };
  let refused: unknown;
  try {
    await runManagedBootstrap(
      { ...bootstrapEnvironment, VERITY_SERVER_IMAGE: composeDigest },
      'amd64',
      managedRoot,
    );
  } catch (error) {
    refused = error;
  }
  expect(
    refused instanceof Error &&
      refused.message === 'VERITY_SERVER_IMAGE does not match the sealed managed deployment image',
    `re-adoption on the Compose digest was not refused: ${String(refused)}`,
  );
  const sealed = await readManagedDeployment(managedRoot);
  if (!sealed.managed) fail(`managed authority unavailable after re-adoption: ${sealed.reason}`);
  expect(
    sealed.spec.image === committedDigest,
    `re-adoption moved the sealed digest to ${sealed.spec.image}`,
  );
  // And on the digest the deployment actually runs it is a no-op rather than an
  // error, so a host that re-runs the migration after an update is not wedged.
  await runManagedBootstrap(
    { ...bootstrapEnvironment, VERITY_SERVER_IMAGE: committedDigest },
    'amd64',
    managedRoot,
  );

  process.stdout.write(`${routedName} survived a restart on ${committedDigest}\n`);
}

/**
 * Turn one service's Compose-rendered `environment` block into the env file the
 * drift stage hands a container. Reading the block and refusing what an env file
 * cannot carry is `composeEnvironmentLines`, which lives in its own module so
 * those refusals have tests; what is left here is the file at either end.
 */
async function composeEnvironment(
  renderedPath: string,
  service: string,
  outputPath: string,
  overrides: readonly string[],
): Promise<void> {
  const config: unknown = JSON.parse(await readFile(renderedPath, 'utf8'));
  let lines: string[];
  try {
    lines = composeEnvironmentLines(config, service, overrides);
  } catch (error) {
    // Re-raised through `fail`, so a refusal still reaches the log under the one
    // prefix every other failure in this harness carries.
    fail(error instanceof Error ? error.message : String(error));
  }
  await writeFile(outputPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  process.stdout.write(`${service}: ${String(lines.length)} variables rendered by Compose\n`);
}

async function main(): Promise<void> {
  const stage = process.argv[2];
  const managedRoot = (): string => required('VERITY_SMOKE_MANAGED_ROOT');
  // Shared across every process below: the journal and the sealed spec on disk
  // are the only state carried between them, which is the point.
  if (stage === 'compose-environment')
    await composeEnvironment(
      requiredArgument(3, 'the rendered Compose document'),
      requiredArgument(4, 'the service to read'),
      requiredArgument(5, 'the env file to write'),
      process.argv.slice(6),
    );
  else if (stage === 'adopt') await adopt(managedRoot());
  else if (stage === 'prepare') await prepare(managedRoot());
  else if (stage === 'preflight-fails') await preflightFails('unmigrated');
  else if (stage === 'preflight-fails-unreachable') await preflightFails('unreachable');
  else if (stage === 'handoff-relay') await startHandoffRelay(managedRoot());
  else if (stage === 'relay-journal') await relayJournal(managedRoot());
  else if (stage === 'cutover-rolls-back') await cutoverRollsBack(managedRoot());
  else if (stage === 'cutover-rolls-back-onto-standby')
    await cutoverRollsBackOntoStandby(managedRoot());
  else if (stage === 'cutover-standby-fails-to-resume')
    await cutoverStandbyFailsToResume(managedRoot());
  else if (stage === 'cutover-recovers-rollback') await cutoverRecoversRollback(managedRoot());
  else if (stage === 'cutover-loses-the-database') await cutoverLosesTheDatabase(managedRoot());
  else if (stage === 'cutover-loses-the-request') await cutoverLosesTheRequest(managedRoot());
  else if (stage === 'cutover-halts-at')
    await cutoverHaltsAt(managedRoot(), haltPoint(process.argv[3]));
  else if (stage === 'cutover-survives-activation-kill')
    await cutoverSurvivesActivationKill(managedRoot());
  else if (stage === 'cutover-rolls-back-after-kill')
    await cutoverRollsBackAfterKill(managedRoot());
  else if (stage === 'cutover-commits-without-the-standby')
    await cutoverCommitsWithoutTheStandby(managedRoot());
  else if (stage === 'cutover-releases-the-drain')
    await cutoverWithClients(managedRoot(), 'released');
  else if (stage === 'cutover-forces-the-drain') await cutoverWithClients(managedRoot(), 'forced');
  else if (stage === 'cutover') await cutoverCommits(managedRoot());
  else if (stage === 'updater-restarts') await updaterRestarts(managedRoot());
  else if (stage === 'companion-handoff') await companionHandoff(managedRoot());
  else fail(`unknown stage: ${String(stage)}`);
}

/** The handles a finished stage legitimately still holds: its own stdio. Nothing
 *  in this harness is a server, so anything else pending once `main` has resolved
 *  is not work in progress — it is something a helper forgot to clear.
 *
 *  Just the two: on Node 24 a pipe reports `PipeWrap` and a terminal `TTYWrap`,
 *  while stdio redirected to a file reports no handle at all, so the file case
 *  needs no entry.
 *
 *  These are type names, not identities, and a child process's stdio is a
 *  `PipeWrap` too — so an abandoned child is the one leak this filter cannot
 *  distinguish from the harness's own stdout. It is a report, not a proof: the
 *  timers and sockets that actually cost wall clock are what it is good at, and
 *  the twelve minutes that prompted it were a `Timeout`. */
const STDIO_HANDLES = new Set(['PipeWrap', 'TTYWrap']);

/** How long a flush may take before the exit stops waiting for it. Long enough
 *  that a busy CI reader still gets the whole report, short enough that a reader
 *  which has stopped consuming cannot hold the stage open. */
const DRAIN_TIMEOUT_MS = 5_000;

/** `process.exit` truncates writes that are still queued, and stdout is a pipe
 *  under CI rather than a terminal — so every stage's last line would be the one
 *  at risk. The empty write orders after whatever the stage already wrote, so its
 *  callback means "everything before this is out".
 *
 *  Bounded, because an exit that waits on a pipe nobody is reading would be the
 *  same bug this function exists to remove, one layer down. */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      stream.off('error', done);
      resolve();
    };
    // Read only from `done`, which cannot run before the assignment completes.
    const timer = setTimeout(done, DRAIN_TIMEOUT_MS);
    timer.unref();
    // A CI reader that died mid-stage makes this write emit EPIPE. Unlistened
    // that is an uncaught exception, which would end the stage on the reader's
    // failure rather than on its own result — so a broken pipe just means the
    // flush is over.
    stream.once('error', done);
    stream.write('', done);
  });
}

/**
 * Exit on the stage's own verdict rather than on the event loop draining.
 *
 * Every stage above is a short-lived process whose contract is: do the stage,
 * say what happened, exit. Leaving the exit to the event loop makes that contract
 * hostage to any timer a shared helper left behind — and it was. An uncleared
 * 120s budget in `waitForHandoffOrFailure` (fixed alongside this) kept six
 * `companion-handoff` stages alive for ~119s each AFTER they had printed their
 * result: about twelve minutes, half this job's wall clock, and invisible in the
 * log because the time landed between two lines rather than inside any one stage.
 *
 * So the exit is unconditional, and anything still pending is named instead of
 * waited for. Naming rather than failing is deliberate: a leaked handle costs the
 * Server this gate is about to release nothing, so it must not be what blocks the
 * release. What it must not do again is go unnoticed.
 */
async function finish(code: number): Promise<never> {
  // A stage that reports failure by setting `exitCode` and returning normally
  // used to be honoured by the natural exit. Nothing in this file does that
  // today, but an explicit exit silently overrides it, so carry it forward
  // rather than leave a future stage's verdict to be discarded here.
  const inherited = process.exitCode;
  // A non-numeric `exitCode` is still a verdict — Node accepts string codes —
  // and reading it as 0 would invert it. `'0'` therefore has to stay a success
  // and anything genuinely unreadable has to fail, so parse first, fail second.
  const inheritedCode = inherited === undefined || inherited === null ? 0 : Number(inherited);
  const verdict = code !== 0 ? code : Number.isInteger(inheritedCode) ? inheritedCode : 1;
  // Recorded before anything below can go wrong: if this process ever ends by
  // some route other than the explicit exit, the verdict still travels with it.
  process.exitCode = verdict;
  // Kept for the rest of the process, unlike the drain's own handler: the flush
  // at exit can still meet a reader that died after the drain resolved, and an
  // unlistened EPIPE there would be an uncaught exception on the last tick.
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  try {
    const pending = process.getActiveResourcesInfo().filter((name) => !STDIO_HANDLES.has(name));
    if (pending.length > 0) {
      // Counted by occurrence and listed the same way, so three pending timers
      // read as three rather than as one deduped name next to the number 3.
      const counted = [...new Map(pending.map((name) => [name, 0])).keys()].map(
        (name) => `${name} x${String(pending.filter((other) => other === name).length)}`,
      );
      process.stderr.write(
        `stage finished holding ${String(pending.length)} handle(s); exiting without waiting for ` +
          `them: ${counted.join(', ')}\n`,
      );
    }
  } catch {
    // Scoped to the diagnostic alone. Failing to report a leak must not also
    // skip the flush below — that would truncate the stage's last lines, which
    // is the exact failure `drain` exists to prevent.
  }
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(verdict);
}

void main()
  .then(() => 0)
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'live self-update smoke failed'}\n`,
    );
    if (error instanceof CandidatePreflightError || error instanceof CandidateReadinessError)
      process.stderr.write(`${error.diagnostics}\n`);
    return 1;
  })
  // One exit path, so a failure while reporting a failure still gets flushed.
  // The trailing catch is the last resort behind it: `finish` is written not to
  // reject, and if that ever stops being true the stage must still end.
  .then(finish, () => finish(1))
  .catch(() => process.exit(1));
