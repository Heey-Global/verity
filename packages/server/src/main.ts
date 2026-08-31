// Deployment entrypoint (concept §, issue #25). Thin composition root: read the
// environment, build the embedded control-plane server, listen, and shut down
// cleanly on a signal. The testable wiring lives in ./embedded.ts; this file is
// just the process glue (excluded from coverage — validated by running it).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildEmbeddedServer,
  parseByteSize,
  parseCpuCores,
  parseDefaultOnFlag,
  parseNonNegativeInt,
  parseOpenCodeEnabled,
  parsePort,
  parsePushEnabled,
  parseTasksProjectNumber,
  parseTranscriptSweep,
  toolkitFeatureRefIsConfigured,
  type EmbeddedServer,
} from './embedded.js';
import { SERVER_VERSION } from './server.js';
import {
  AGENT_SEED_MOUNT_PATH,
  readAgentSeedStamp,
  sandboxAgentSeedHostPath,
} from './self-update/agent-seed-stamp.js';
import {
  createPostgresDb,
  migrateToLatest,
  migrationProvider,
  PostgresAdvisoryLockHeldError,
} from '@verity/store';
import { createGhTokenReader } from './github.js';
import {
  createControlPlaneGenerationFence,
  GenerationFenceLostError,
} from './self-update/control-plane-generation.js';
import {
  claimControlPlaneGeneration,
  classifyKeeperLoss,
  openControlPlaneProcessLock,
  watchControlPlaneGeneration,
  type ControlPlaneHold,
  type ControlPlaneLoss,
  type HeldControlPlaneGeneration,
} from './self-update/control-plane-hold.js';
import type { DockerGcPolicy } from './docker-gc.js';
import { createDockerClient } from './docker.js';
import { startInternalListener, type InternalListener } from './internal-listener.js';
import {
  isPreflightCommand,
  preflightConfigFromEnv,
  runPreflight,
} from './self-update/preflight.js';
import { waitForActivationGate } from './self-update/activation-gate.js';
import { MANAGED_DEPLOYMENT_ROOT, runManagedBootstrap } from './self-update/managed-bootstrap.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import {
  createReleaseChannelResolver,
  type ReleaseArchitecture,
  type ReleaseChannelResolver,
} from './self-update/release-channel.js';
import { createReleaseChannelArtifactLoader } from './self-update/release-channel-artifact.js';
import { createReleaseChannelVerifier } from './self-update/release-channel-verify.js';
import { releaseChannelMetadataFromEnv } from './self-update/release-channel-publish.js';
import { startManagedGateway } from './self-update/managed-gateway.js';
import {
  MANAGED_CLIENT_IDENTITY_HEADER,
  verifyManagedClientIdentity,
} from './managed-client-identity.js';
import {
  agentSeedPublicationKey,
  publishAgentSeedAtomically,
  readPublishedAgentSeedDigest,
  runManagedCompanionHandoff,
  validatePublishedAgentSeed,
} from './self-update/managed-companion-reconcile.js';
import {
  MANAGED_GATEWAY_CONTROL_SOCKET,
  startManagedGatewayControlServer,
} from './self-update/managed-gateway-control.js';
import {
  readinessProbeOptionsFromEnvironment,
  runReadinessProbe,
} from './self-update/readiness-probe.js';
import { recoverManagedUpdater } from './self-update/update-runner.js';
import { serverUpdateNotifierStatePath } from './self-update/server-update-notifier.js';
import {
  startSecretKeyAdoption,
  type SecretKeyAdoption,
} from './self-update/secret-key-adopter.js';
import {
  startSecretKeyHandoffResponder,
  type SecretKeyHandoffResponderLoop,
} from './self-update/secret-key-handoff-responder.js';
import {
  createSecretKeyHandoffClient,
  createAgentSeedProvenanceClient,
  createServerUpdateController,
  createStandbyDirectiveClient,
  type AgentSeedProvenanceClient,
} from './self-update/server-update-controller.js';
import { legacyDopplerCredentialEnvironmentKeys } from './legacy-doppler-configuration.js';
import { createStandbyExchange } from './self-update/standby-directive.js';
import { startStandbyFollower, type StandbyFollowerLoop } from './self-update/standby-follower.js';
import { createStandbyLifecycle, type ServingStack } from './self-update/standby-lifecycle.js';
import { startUpdaterStatusServer } from './self-update/updater-status.js';
import { readControlPlanePostgresState } from './self-update/postgres-image.js';
import {
  readManagedDeployment,
  type ManagedDeploymentState,
} from './self-update/managed-deployment.js';
import {
  createCachedImageVersionResolver,
  createPublishedDefaultResolver,
  releasePinnedRef,
  resolveWithTimeout,
  resolvePublicOciLatestSemverDigest,
  resolvePublicOciTagDigest,
} from './oci-ref.js';
import {
  DEFAULT_AGENT_GATEWAY_CONTROL_SOCKET,
  resolveAgentGatewayUnsealKey,
} from './agent-gateway-unseal-key.js';
import { resolveProjectRelayImage } from './project-relay-image.js';
import { UPLINK_CONTROL_URL } from './uplink-control-client.js';
import { createDevicePairingManager } from './device-pairing.js';

/** Fixed internal port for the non-published `/internal/*` (signing-broker)
 *  listener. Container-internal only, never on `ports:` — no host conflict, so it
 *  is a constant, not operator config. */
const DEFAULT_INTERNAL_PORT = 8083;
const SANDBOX_IMAGE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox';
const TOOLKIT_FEATURE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit';
const PREVIEW_CONNECTOR_IMAGE_REPO = 'ghcr.io/heey-global/verity/verity-preview-connector';
const DEFAULT_SANDBOX_IMAGE_TAG = `${SANDBOX_IMAGE_REPO}:latest`;
const DEFAULT_SANDBOX_IMAGE_FALLBACK =
  'ghcr.io/heey-global/verity/verity-sandbox@sha256:7445ec4d7aa770cb66d238621be6b4f2fc617cdc29db2142c8825f831f84fcfc';
const DEFAULT_TOOLKIT_FEATURE_TAG = `${TOOLKIT_FEATURE_REPO}:latest`;
const DEFAULT_TOOLKIT_FEATURE_FALLBACK = `${TOOLKIT_FEATURE_REPO}:1.14.9`;

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Parse a positive number from env; undefined for absent, blank, or unparseable
 *  values so a typo degrades to the documented default rather than to 0 (which,
 *  for a retention count, would mean "keep nothing"). */
function positiveNumberEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Operator overrides for the host-disk GC. Every knob is optional; omitted ones
 *  fall through to DEFAULT_DOCKER_GC_POLICY in `docker-gc.ts`. */
function dockerGcPolicyFromEnv(): Partial<DockerGcPolicy> {
  const keepImagesPerRepo = positiveNumberEnv(process.env.VERITY_DOCKER_GC_KEEP_IMAGES);
  const volumeMinAgeHours = positiveNumberEnv(process.env.VERITY_DOCKER_GC_VOLUME_MIN_AGE_HOURS);
  const buildCacheMaxAgeHours = positiveNumberEnv(
    process.env.VERITY_DOCKER_GC_BUILD_CACHE_MAX_AGE_HOURS,
  );
  const lowDiskFreeGb = positiveNumberEnv(process.env.VERITY_DOCKER_GC_LOW_DISK_GB);
  return {
    ...(keepImagesPerRepo !== undefined ? { keepImagesPerRepo } : {}),
    ...(volumeMinAgeHours !== undefined ? { volumeMinAgeMs: volumeMinAgeHours * 3_600_000 } : {}),
    ...(buildCacheMaxAgeHours !== undefined
      ? { buildCacheMaxAgeMs: buildCacheMaxAgeHours * 3_600_000 }
      : {}),
    ...(lowDiskFreeGb !== undefined ? { lowDiskFreeBytes: lowDiskFreeGb * 1024 ** 3 } : {}),
  };
}

/** The release architecture this host can actually run, or null if Verity
 *  publishes no images for it. */
/**
 * The architecture whose channel this host may consult.
 *
 * Deliberately narrower than the {@link ReleaseArchitecture} union: the release
 * workflow builds and publishes `linux/amd64` only, so `channel-stable-arm64`
 * does not exist yet. Returning `'arm64'` here would make an ARM host chase a
 * missing tag and report the channel as `unreachable` — a transient-sounding
 * error for a permanent condition. Reporting no architecture at all leaves
 * `/server/updates` at `unsupported`, which is what "no release is published
 * for this host" actually means. Widen this the moment the workflow publishes a
 * second channel.
 */
function hostReleaseArchitecture(): ReleaseArchitecture | null {
  return process.arch === 'x64' ? 'amd64' : null;
}

/**
 * The signed stable release channel (ADR 0008 D4).
 *
 * `managed` gates the whole lookup: only a deployment the Updater owns can act
 * on a release, and `VERITY_MANAGED_DEPLOYMENT_ID` is forwarded exclusively into
 * the managed Server by `managed-bootstrap`, so a legacy Compose deployment
 * never even contacts the channel and keeps reporting `unsupported`.
 */
function buildReleaseChannelResolver(
  architecture: ReleaseArchitecture | null,
  verityRoot: string,
): ReleaseChannelResolver {
  if (architecture === null) {
    const reason = `no release channel is published for ${process.arch}`;
    return { resolve: () => Promise.resolve({ state: 'unsupported', reason, operation: null }) };
  }
  return createReleaseChannelResolver({
    managed: Boolean(process.env.VERITY_MANAGED_DEPLOYMENT_ID?.trim()),
    current: SERVER_COMPAT,
    architecture,
    load: createReleaseChannelArtifactLoader({ architecture }),
    verify: createReleaseChannelVerifier({
      // Persisted on the data volume so the Sigstore trusted root survives a
      // restart and the first update check after a cutover is not a cold TUF
      // bootstrap.
      tufCachePath: join(verityRoot, 'sigstore'),
      onReject: (reason) => console.warn(`[self-update] release channel rejected: ${reason}`),
    }),
  });
}

/**
 * The group allowed to use the Updater's control socket.
 *
 * Derived from the sealed spec rather than from the environment: the same
 * document that decides the Server runs as this gid also decides whether the
 * control volume reaches it. A deployment sealed before the mount existed keeps
 * an owner-only socket, which is exactly right — its Server has no path to the
 * volume, so publishing a token there would widen the boundary for nobody.
 */
function updaterPeerGid(state: ManagedDeploymentState): number | undefined {
  if (!state.managed) return undefined;
  const mounted = state.spec.mounts.some(
    (mount) => mount.source.kind === 'volume' && mount.source.name === 'verity-updater-control',
  );
  return mounted ? state.spec.user.gid : undefined;
}

/** Bounded retry for the agent-seed report: ~5 minutes, which covers an Updater
 *  that is resuming an interrupted operation before it publishes its boundary. */
const AGENT_SEED_REPORT_ATTEMPTS = 20;
const AGENT_SEED_REPORT_INTERVAL_MS = 15_000;

/** Just enough of the Fastify logger to say this, so the reporter can be read
 *  without the server type. */
interface ProvenanceLog {
  warn(context: object, message: string): void;
  info(context: object, message: string): void;
}

/**
 * Say which release the wrappers in every sandbox actually come from.
 *
 * Managed publication converges this stamp before the update operation can
 * complete. A mismatch therefore identifies an interrupted companion handoff
 * or an out-of-band bootstrap, while standalone deployments retain their
 * existing report-only behaviour.
 *
 * Retried, and off the startup path. The Updater publishes its socket and token
 * only after it has finished resuming an interrupted operation, so a Server that
 * boots quickly asks before there is anything to ask — and a single attempt
 * would turn a few seconds of startup ordering into a deployment that never
 * mentions the skew again for the life of the process. Waiting for it inside
 * startup would be worse: this is a report, and nothing about serving depends
 * on it.
 */
function reportAgentSeedProvenance(client: AgentSeedProvenanceClient, log: ProvenanceLog): void {
  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const seed = await client.read();
        if (seed.state === 'skewed')
          log.warn(
            {
              seedVersion: seed.stamp.version,
              seedImage: seed.stamp.image,
              serverVersion: SERVER_VERSION,
            },
            'verity: the selected agent seed does not match this Server; managed companion ' +
              'reconciliation remains incomplete and will retry from its durable journal',
          );
        else if (seed.state === 'matched')
          log.info(
            { seedVersion: seed.stamp.version },
            'verity: the agent seed on the host matches this Server',
          );
        else
          log.info(
            { reason: seed.reason },
            'verity: the agent seed on the host cannot be attributed to a release',
          );
        return;
      } catch (error) {
        // An Updater that never answers is a fact about the Updater, not about
        // the seed — so this ends in a statement that the question is open,
        // rather than in silence that reads like "the seed is fine".
        if (attempt === AGENT_SEED_REPORT_ATTEMPTS) {
          log.info(
            { err: error },
            'verity: the Updater never answered, so the agent seed on the host stays unattributed',
          );
          return;
        }
      }
      // Unref'd: a shutdown must not wait out an interval that exists only to
      // ask the Updater one more time.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, AGENT_SEED_REPORT_INTERVAL_MS).unref();
      });
    }
  })();
}

interface ClaimedControlPlane {
  readonly held: HeldControlPlaneGeneration;
  readonly hold: ControlPlaneHold;
  readonly onLost: (handler: (loss: ControlPlaneLoss) => void) => void;
  readonly close: () => Promise<void>;
}

let cleanupStartup: () => Promise<void> = () => Promise.resolve();

/**
 * Claim the control-plane generation for this Server (ADR 0008 D7).
 *
 * Claimed on a dedicated connection BEFORE the embedded server is built,
 * because that build starts schedulers and recovery: a Server that must not be
 * the control plane has to find that out before it does any work, not after.
 * The migration runs here for the same reason — the fence lives in the schema,
 * so something has to create it, and on this path there is exactly one Server.
 * The standby entrypoint never reaches this code and keeps migrating nothing.
 *
 * The holder id names a control-plane slot and is supplied by the deployment.
 * It is stable across ordinary recreation and distinct from every Server that
 * could run beside it. The dedicated PostgreSQL session lock, not this string,
 * proves exclusive process ownership. Absent, the fence is not claimed at all,
 * preserving older deployment behaviour.
 */
async function claimControlPlane(databaseUrl: string): Promise<ClaimedControlPlane | undefined> {
  const holderId = process.env.VERITY_CONTROL_PLANE_HOLDER_ID?.trim();
  if (holderId === undefined || holderId.length === 0) return undefined;
  if (process.env.VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION === '1') {
    const operationId = process.env.VERITY_UPDATE_ID?.trim();
    if (operationId === undefined || operationId.length === 0)
      throw new Error('VERITY_UPDATE_ID is required while waiting for activation');
    await waitForActivationGate(operationId);
  }
  let lostHandler = (loss: ControlPlaneLoss): void => {
    console.error('verity: control-plane authority lost during startup', loss);
    process.exit(1);
  };
  const processLock = await openControlPlaneProcessLock({
    connectionString: databaseUrl,
    waitForActivation: process.env.VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION === '1',
    onLost: (error) => {
      console.error('verity: PostgreSQL control-plane process lock lost', error);
      lostHandler(classifyKeeperLoss(error));
    },
    onRetry: (error) => {
      console.warn(`verity: control-plane database not reachable yet (${String(error)}); retrying`);
    },
  });
  const db = createPostgresDb(databaseUrl);
  try {
    // The forward promise this image was built with (`VERITY_SCHEMA_FORWARD_MAX`,
    // absent on every ordinary release, so `max` is then just this build's own
    // latest migration and nothing is tolerated). It is what lets a bridge build
    // START on the database the generation it is rolled back FROM already
    // migrated — ADR 0008 D9's rollback contract, which cannot hold while the
    // migrator is never told what the image promised.
    await migrateToLatest(db, migrationProvider, { forwardMax: SERVER_COMPAT.schema.max });
    const fence = createControlPlaneGenerationFence(db);
    const held = await claimControlPlaneGeneration({
      fence,
      holderId,
      // Names the update that produced this generation, not this process. A
      // plain start has no update behind it.
      operationId: process.env.VERITY_UPDATE_ID?.trim() || 'bootstrap',
      exclusiveProcessLock: true,
    });
    // Arms the keeper's post-reconnect check. Only the fence's OWN verdict
    // answers `false`; anything else rejects, which the keeper retries — the
    // same rule `watchControlPlaneGeneration` applies to its heartbeat.
    await processLock.activateShared(() =>
      fence.assertActive(held).then(
        () => true,
        (error: unknown) => {
          if (error instanceof GenerationFenceLostError) return false;
          throw error;
        },
      ),
    );
    const hold = watchControlPlaneGeneration({
      fence,
      held,
      onLost: () => lostHandler({ kind: 'generation-taken' }),
      onError: (error: unknown) => {
        console.warn('verity: control-plane fence heartbeat failed', error);
      },
    });
    return {
      held,
      hold,
      onLost: (handler: (loss: ControlPlaneLoss) => void) => {
        lostHandler = handler;
      },
      close: async () => {
        await db.destroy();
        await processLock.release();
      },
    };
  } catch (error) {
    await db.destroy().catch(() => undefined);
    await processLock.release().catch(() => undefined);
    throw error;
  }
}

/**
 * Offer this container's ephemeral public key to the Server being replaced.
 *
 * Only a Server started for an update has a predecessor to receive a key from;
 * an ordinary start has nothing to adopt and must not go looking. Absent an
 * Updater control socket there is no mailbox either, and the promoted Server
 * simply comes up sealed as it always did.
 */
async function startSecretKeyAdoptionForUpdate(): Promise<SecretKeyAdoption | undefined> {
  if (process.env.VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION !== '1') return undefined;
  const operationId = process.env.VERITY_UPDATE_ID?.trim();
  if (operationId === undefined || operationId.length === 0) return undefined;
  const client = await createSecretKeyHandoffClient();
  if (client === undefined) return undefined;
  return startSecretKeyAdoption({
    client,
    operationId,
    onError: (error: unknown) => {
      console.warn('verity: secret-key adoption poll failed', error);
    },
  });
}

/** The git repo root, so `repoDir` is `/work` even when the server's cwd is a
 * subdir (npm-workspace runs from packages/server). Undefined outside a repo. */
function gitToplevel(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

async function tlsFromEnvironment(): Promise<{ key: Buffer; cert: Buffer } | undefined> {
  const keyPath = process.env.VERITY_TLS_KEY_PATH?.trim();
  const certPath = process.env.VERITY_TLS_CERT_PATH?.trim();
  if (!keyPath && !certPath) return undefined;
  if (!keyPath || !certPath) {
    throw new Error('VERITY_TLS_KEY_PATH and VERITY_TLS_CERT_PATH must be configured together');
  }
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

function managedClientIdentitySecret(key: Buffer): Buffer {
  return createHash('sha256').update('verity.managed-client-identity.v1\0').update(key).digest();
}

async function main(): Promise<void> {
  const directServerMode = process.argv[2] === 'direct-server';
  if (process.argv[2] === 'managed-gateway') {
    const tls = await tlsFromEnvironment();
    const gateway = await startManagedGateway({
      ...(tls === undefined ? {} : { tls }),
      ...(tls === undefined ? {} : { clientIdentitySecret: managedClientIdentitySecret(tls.key) }),
      publicHost: process.env.HOST ?? '0.0.0.0',
      publicPort: parsePort(process.env.PORT),
      internalHost: process.env.VERITY_INTERNAL_HOST ?? '0.0.0.0',
      internalPort: parsePort(process.env.VERITY_INTERNAL_PORT, DEFAULT_INTERNAL_PORT),
      backend: {
        host: 'verity-managed-server',
        publicPort: parsePort(process.env.VERITY_MANAGED_SERVER_PORT, 8082),
        internalPort: parsePort(process.env.VERITY_MANAGED_SERVER_INTERNAL_PORT, 8083),
      },
      allowedBackendHosts: ['verity-managed-server'],
      allowManagedServerGenerations: true,
      backendStatePath:
        process.env.VERITY_MANAGED_GATEWAY_STATE_PATH ?? '/run/verity-gateway/backend.json',
    });
    // The Updater has no network, so the maintenance switch and the backend
    // selection are only reachable over the shared control volume. Started
    // unconditionally and allowed to fail loudly: in the managed profile the
    // volume is always mounted, and a Gateway that came up without its control
    // channel would only reveal that in the middle of an update.
    const control = await startManagedGatewayControlServer({
      socketPath:
        process.env.VERITY_MANAGED_GATEWAY_CONTROL_SOCKET ?? MANAGED_GATEWAY_CONTROL_SOCKET,
      gateway,
    }).catch(async (error: unknown) => {
      await gateway.close();
      throw error;
    });
    const stop = async (): Promise<void> => {
      await control.close();
      await gateway.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    return;
  }
  if (process.argv[2] === 'managed-companion-handoff') {
    await runManagedCompanionHandoff(
      createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' }),
    );
    return;
  }
  if (process.argv[2] === 'publish-agent-seed') {
    const image = process.env.VERITY_SERVER_IMAGE;
    if (image === undefined) throw new Error('VERITY_SERVER_IMAGE is required');
    // Compose owns bootstrap only. Once a complete pointer exists, managed
    // publication belongs exclusively to the Updater's target-image helper;
    // an old compose pin must never race it or move the pointer backwards.
    const selectedDigest = await readPublishedAgentSeedDigest('/opt/agent-seed-host');
    if (selectedDigest !== null && (process.env.VERITY_MANAGED_DEPLOYMENT_ID ?? '').trim() !== '') {
      const selected = '/opt/agent-seed-host/.current';
      const stamp = await readAgentSeedStamp(selected);
      if (stamp === null || agentSeedPublicationKey(stamp.image, stamp.version) !== selectedDigest)
        throw new Error('selected agent seed has invalid provenance');
      await validatePublishedAgentSeed(selected, stamp.image, stamp.version);
      return;
    }
    await publishAgentSeedAtomically(
      '/opt/verity-features/verity-sandbox-toolkit/agent-seed',
      '/opt/agent-seed-host',
      image,
      process.env.VERITY_SERVER_VERSION ?? '0.0.0-dev',
    );
    return;
  }
  if (process.argv[2] === 'managed-updater') {
    const tokenFile = process.env.VERITY_UPDATER_TOKEN_FILE;
    if (tokenFile === undefined || !tokenFile.startsWith('/run/secrets/')) {
      throw new Error('VERITY_UPDATER_TOKEN_FILE must name a /run/secrets file');
    }
    const tokenInfo = await lstat(tokenFile);
    if (
      !tokenInfo.isFile() ||
      tokenInfo.isSymbolicLink() ||
      tokenInfo.uid !== process.geteuid?.() ||
      (tokenInfo.mode & 0o077) !== 0
    ) {
      throw new Error('Updater control token file must be a private regular file');
    }
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
    // An Updater that died mid-update left durable intent behind, and the
    // journal is the only thing that knows how far it got. Finish that, then
    // reconcile — both before the boundary opens, so a restart continues the
    // operation instead of stranding it, and so the single slot is free again
    // by the time a device retries.
    // Shared between the control boundary, which publishes the directive and
    // collects what the outgoing Server reports, and the cutover, which asks and
    // then waits for it before promoting a candidate (ADR 0008 D9). Created here
    // because it is the one thing both halves of this process look at.
    const standby = createStandbyExchange();
    const runner = await recoverManagedUpdater({
      managedRoot: MANAGED_DEPLOYMENT_ROOT,
      docker,
      cutover: { standby },
    });
    const peerGid = updaterPeerGid(await readManagedDeployment(MANAGED_DEPLOYMENT_ROOT));
    // Passed only when the read-only seed mount is really there. A deployment
    // whose compose file predates that mount has to report "not visible", which
    // is a different fact from "mounted, and the seed carries no stamp" — the
    // first says nothing about the sandboxes, the second says they are running
    // wrappers of unknown provenance.
    const managedSeedPath = join(AGENT_SEED_MOUNT_PATH, '.current');
    const agentSeedPath = await stat(managedSeedPath).then(
      (info) => (info.isDirectory() ? managedSeedPath : undefined),
      () => undefined,
    );
    const updater = await startUpdaterStatusServer({
      socketPath: '/run/verity-updater/control/updater.sock',
      token,
      managedRoot: MANAGED_DEPLOYMENT_ROOT,
      standby,
      // What the reconcile above concluded. An Updater that tolerated a running
      // Server on a drifted environment has to be able to say so, or the
      // tolerance is indistinguishable from not having looked.
      reconcile: runner.reconcile,
      // Read fresh on every request rather than captured once: the digest this
      // answers for changes underneath the boundary — a cutover swaps it — and a
      // value taken at startup would keep reporting the state that existed
      // before the update that fixed it (ADR 0008 D14).
      postgres: async () => {
        const state = await readManagedDeployment(MANAGED_DEPLOYMENT_ROOT);
        if (!state.managed) throw new Error(state.reason);
        return readControlPlanePostgresState({
          docker,
          serverImage: state.spec.image,
          network: state.spec.network,
        });
      },
      ...(agentSeedPath === undefined ? {} : { agentSeedPath }),
      ...(peerGid === undefined ? {} : { peerGid }),
      onOperationAccepted: () => {
        runner.start();
      },
    });
    const stop = async (): Promise<void> => {
      await updater.close();
      // Every step is journalled before it runs, so being killed here is safe —
      // but finishing the current one avoids an avoidable resume.
      await runner.idle();
      process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
    return;
  }
  if (process.argv[2] === 'managed-bootstrap') {
    await runManagedBootstrap(process.env);
    return;
  }
  // Release-CI entrypoint (ADR 0008 D4): print the channel document describing
  // THIS image, so the compatibility window that gets signed is the one the
  // build actually ships rather than a copy maintained in workflow YAML.
  if (process.argv[2] === 'release-channel-metadata') {
    process.stdout.write(releaseChannelMetadataFromEnv(process.env));
    return;
  }
  // Readiness verdict for standby promotion. The Updater has no network at
  // all, so it starts this same image as a one-shot container on the managed
  // network and reads the answer off the exit code (0 = serving, 1 = not).
  if (process.argv[2] === 'readiness-probe') {
    const result = await runReadinessProbe(readinessProbeOptionsFromEnvironment(process.env));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  // Legacy passive-candidate entrypoint retained for old prepared journals.
  if (process.argv[2] === 'standby') {
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    return;
  }
  // Self-update preflight entrypoint (ADR 0008 D5). ONLY an explicit `preflight`
  // invocation branches here; every other start falls through to the unchanged
  // default path below. Preflight is read-only: it validates schema/mount/port
  // readiness and exits with a status code (0 = ready, 1 = not ready) WITHOUT
  // migrating, scheduling, or listening.
  if (isPreflightCommand(process.argv, process.env)) {
    const report = await runPreflight(preflightConfigFromEnv(process.env));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  const legacyDopplerCredentialKeys = legacyDopplerCredentialEnvironmentKeys(process.env);
  if (legacyDopplerCredentialKeys.length > 0) {
    console.error(
      `FATAL: legacy Doppler credential environment is forbidden; remove ${legacyDopplerCredentialKeys.sort().join(', ')} and configure the central Verity broker identity`,
    );
    process.exit(1);
  }

  // Postgres is the only runtime database (pglite has been removed from the
  // production runtime; it remains a TEST-ONLY in-memory path in @verity/store).
  // Fail fast BEFORE building the server so a misconfigured deployment surfaces a
  // clear error instead of silently opening an ephemeral store.
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    console.error(
      'FATAL: DATABASE_URL is required (Verity now uses PostgreSQL; pglite has been removed from the runtime)',
    );
    process.exit(1);
  }

  let startupStopping = false;
  const stopDuringStartup = (signal: NodeJS.Signals): void => {
    if (startupStopping) return;
    startupStopping = true;
    console.error(`verity: ${signal} received during startup`);
    // Cleanup is serialized by `main` at its next async boundary so authority is
    // never released while startup continues. If that boundary is permanently
    // wedged, exit without releasing explicitly; PostgreSQL then drops every
    // session lock with the process, which is the safe forced-cleanup path.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  const stopStartupIfRequested = async (): Promise<boolean> => {
    if (!startupStopping) return false;
    try {
      await cleanupStartup();
    } finally {
      process.exit(1);
    }
  };
  process.once('SIGINT', stopDuringStartup);
  process.once('SIGTERM', stopDuringStartup);

  // Started before the control-plane claim, because that claim blocks on the
  // activation gate and the offer has to be in the Updater's mailbox while the
  // Server being replaced is still running to answer it (ADR 0008 D8).
  const secretKeyAdoption = await startSecretKeyAdoptionForUpdate();
  cleanupStartup = () => {
    secretKeyAdoption?.stop();
    return Promise.resolve();
  };

  const port = parsePort(process.env.PORT);
  // Default to loopback (audit C1 defense-in-depth): the control plane is only
  // reachable from the same host unless the operator explicitly opts into a
  // routable interface via HOST (e.g. HOST=0.0.0.0, or a specific LAN IP). The
  // bearer-token gate is the real protection; this default just prevents an
  // accidental open bind. For multi-device access, front the loopback server
  // with a TLS reverse proxy, or set HOST to a network interface on a trusted
  // network — note that without TLS the bearer token travels in cleartext.
  const host = process.env.HOST ?? '127.0.0.1';
  // Verity OWNS its own signing/broker wiring — the operator does not configure it
  // (issue: these were env "config" but are really internal plumbing). The
  // dedicated `/internal/*` listener (commit-signing broker) is ALWAYS on, at a
  // fixed internal port, bound on 0.0.0.0 (reachable on the internal Docker network)
  // but NOT published to the host — the public API port 404s `/internal/*`. The
  // env vars below stay only as optional overrides for non-standard topologies.
  const internalPort = process.env.VERITY_INTERNAL_PORT
    ? parsePort(process.env.VERITY_INTERNAL_PORT)
    : DEFAULT_INTERNAL_PORT;
  const internalHost = process.env.VERITY_INTERNAL_HOST ?? '0.0.0.0';
  const projectRelayImage = resolveProjectRelayImage(process.env);
  const projectRelayGid = parseNonNegativeInt(process.env.VERITY_PROJECT_RELAY_GID) ?? 65_532;
  const runnerRuntimeGid = parseNonNegativeInt(process.env.VERITY_RUNNER_RUNTIME_GID) ?? 1101;
  if (runnerRuntimeGid === 0) {
    throw new Error('VERITY_RUNNER_RUNTIME_GID must be a positive group ID');
  }
  // Public sharing is a paid feature the Uplink grants and operates (ADR 0012).
  // It is deliberately unconfigurable here: an installation holds no cluster
  // credentials, and the subscription key that identifies it lives in the
  // encrypted secret store, never in an environment variable or a host file
  // (D3, invariant 5). Until the Uplink client lands, `publicPreviews` has no
  // implementation to bind and sharing stays off — there is no direct path to
  // fall back to.
  const dataVolume = process.env.VERITY_DATA_VOLUME?.trim();
  if (dataVolume === undefined || dataVolume.length === 0) {
    throw new Error('VERITY_DATA_VOLUME is required for project relay Unix sockets');
  }
  const ghTokenFilePath = process.env.VERITY_GH_TOKEN_FILE ?? join(homedir(), '.gh-token');

  // Single data root. Verity derives everything it needs to put on disk under here:
  //   <root>/workspaces  — project clones, host-visible (bind-mounted into sibling
  //                        sandboxes → must be an absolute HOST path in the deploy)
  //   <root>/secrets     — short-lived materialized files (the gh-token-broker
  //                        capability, signing token, non-secret git material)
  //   <root>/sessions    — the server's own session worktrees
  // The DB is no longer on disk (Postgres), so there is nothing else to configure —
  // one VERITY_ROOT replaces the former per-directory env vars. In a container this
  // must be a host path mounted at the identical path (see docker-compose.yml).
  const verityRoot = process.env.VERITY_ROOT ?? '/srv/verity';
  const releaseArchitecture = hostReleaseArchitecture();

  // Hand out the sibling artifacts THIS Server release was published with, and
  // fall back to the published-latest channel only on builds that have no
  // release version to name them by (dev/PR). Both defaults feed the sandbox
  // update checker as well as provisioning, so on a released Server the "update
  // available" signal now follows the Server upgrade rather than a sandbox image
  // published ahead of it — which is the point: an image newer than this
  // Server's bundled toolkit is precisely the one it cannot attest.
  const sandboxImageTag = releasePinnedRef(SANDBOX_IMAGE_REPO, 'v') ?? DEFAULT_SANDBOX_IMAGE_TAG;
  const toolkitFeatureTag =
    releasePinnedRef(TOOLKIT_FEATURE_REPO, '') ?? DEFAULT_TOOLKIT_FEATURE_TAG;
  // The fallbacks stay on artifacts that are known to EXIST, and deliberately do
  // not follow the pin. A pinned tag is only ever unresolvable when its release
  // job did not produce it — `release.yml` gates the server publish on both
  // siblings so that should not happen, but if it ever does, repeating the same
  // missing tag as the fallback would turn one failed publish into a deployment
  // that cannot provision at all. An existing image from another release still
  // runs; its toolkit mismatch is caught by the boundary attestation and named
  // in the startup drift report, which is a loud failure rather than a silent
  // one. And it is reached only on a cold start during a registry outage:
  // otherwise the resolver hands back the digest it last resolved.
  const defaultProjectImage = createPublishedDefaultResolver(
    process.env.VERITY_DEFAULT_PROJECT_IMAGE,
    sandboxImageTag,
    DEFAULT_SANDBOX_IMAGE_FALLBACK,
    'default project image',
  );
  // Cached and timeout-bounded like the two resolvers around it. As a bare
  // passthrough this was the one registry reader on the request path with
  // neither: the update checker asks for it while serializing a project, and
  // each miss is a three-manifest walk against ghcr.io.
  const defaultProjectImageVersion = createCachedImageVersionResolver();
  const devcontainerFeatureRef = createPublishedDefaultResolver(
    process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF,
    toolkitFeatureTag,
    DEFAULT_TOOLKIT_FEATURE_FALLBACK,
    'sandbox toolkit Feature',
    // `:latest` on the Feature repo is a channel tag that has to be walked back
    // to the newest semver; a release-pinned tag IS the semver and must be
    // resolved as itself, or the pin would be discarded on the way to a digest.
    toolkitFeatureTag === DEFAULT_TOOLKIT_FEATURE_TAG
      ? resolvePublicOciLatestSemverDigest
      : resolvePublicOciTagDigest,
  );

  const serverUpdateController = await createServerUpdateController();
  const secretKeyHandoffClient = await createSecretKeyHandoffClient();
  const standbyDirectiveClient = await createStandbyDirectiveClient();
  const agentSeedProvenance = await createAgentSeedProvenanceClient(
    SERVER_VERSION,
    process.env.VERITY_SERVER_IMAGE,
  );
  if (await stopStartupIfRequested()) return;

  /**
   * The live incarnation's logger, replaced whenever a standby resumes.
   *
   * Process-level so the signal handlers below can log without holding on to the
   * first incarnation, which a resume has already closed.
   */
  let log: EmbeddedServer['app']['log'] | undefined;
  let handoffResponder: SecretKeyHandoffResponderLoop | undefined;
  let standbyFollower: StandbyFollowerLoop | undefined;
  /**
   * What to do when the generation is taken away from under this process.
   *
   * Registered per incarnation but handled once, at the process level, so it
   * still resolves to the ordered shutdown after a standby has resumed. Until
   * that handler exists, startup itself is the only thing running — and startup
   * cleanup, not a serving stack, is what has to be undone.
   */
  let onFenceLost = (): void => {
    void cleanupStartup().finally(() => process.exit(1));
  };
  /**
   * Record how to undo a half-built incarnation — but only while that is what
   * startup is doing.
   *
   * The same builder runs again when a standby resumes, and by then a failure is
   * not a failed startup: `main` has long since returned, the process is not
   * exiting, and the builder's own unwind already covers it. Leaving the hook
   * pointing at a live stack would just be a stale reference to something the
   * ordered shutdown owns.
   */
  let startupBuilding = true;
  const onStartupFailure = (undo: () => Promise<void>): void => {
    if (startupBuilding) cleanupStartup = undo;
  };

  /**
   * Everything this process does as the control plane, built as one disposable
   * incarnation (ADR 0008 D7).
   *
   * Called once at startup and again whenever a quiesced standby is asked to
   * serve after a failed update. Each call claims the generation afresh — CAS
   * hands out a NEWER one, never the number this process had before, so a
   * rollback cannot be mistaken for the generation it replaced. Nothing above
   * this function is per-incarnation: the configuration is read once, and the
   * Updater clients belong to the process.
   *
   * `adoptedSecretKeyMaterial` is the key of the incarnation this one replaces.
   * On the first call there is none and the D8 mailbox is consulted instead —
   * the key the *previous Server* sealed for this container. Later calls carry
   * this process's own key across the gap, so a resumed standby comes back
   * unsealed rather than at a master-password prompt.
   */
  const startServingStack = async (input: {
    adoptedSecretKeyMaterial?: string;
  }): Promise<ServingStack> => {
    const controlPlane = await claimControlPlane(databaseUrl);
    await stopStartupIfRequested();
    // Only now: holding the generation is what earns this process the right to
    // the key. The wait is a grace window for a read already in flight, not a
    // search — the Server that could seal was stopped before this gate opened,
    // so a mailbox that is empty here stays empty. Startup must never spend a
    // readiness budget on an optimisation; the master-password prompt is still
    // there.
    const adoptedSecretKeyMaterial =
      input.adoptedSecretKeyMaterial ?? (await secretKeyAdoption?.claim());
    /**
     * Undo what this call has built, in the order an ordered stop uses.
     *
     * At most once: the failure path below and the startup-signal hooks both
     * reach for it, and whichever arrives first is the one that knows what was
     * open. A second pass would close an already-closed server and release a
     * generation this process no longer holds.
     */
    let unwound = false;
    const unwind = async (started?: EmbeddedServer, internal?: InternalListener): Promise<void> => {
      if (unwound) return;
      unwound = true;
      await internal?.close();
      await started?.close();
      if (controlPlane !== undefined) {
        try {
          await controlPlane.hold.release();
        } finally {
          await controlPlane.close();
        }
      }
    };
    /**
     * What the build has opened so far, so a failure closes it.
     *
     * The `onStartupFailure` hooks below cover the same ground during startup,
     * where a signal unwinds the process rather than this call. They are inert
     * once startup is over — and a resume runs this builder with startup long
     * gone, so a listener opened here would otherwise survive the release of the
     * generation and the keeper lock: exactly the second unfenced control plane
     * the fence exists to prevent.
     */
    const built: { server?: EmbeddedServer; internal?: InternalListener } = {};
    try {
      return await buildAndListen({ controlPlane, adoptedSecretKeyMaterial, unwind, built });
    } catch (error) {
      await unwind(built.server, built.internal).catch(() => undefined);
      throw error;
    }
  };

  const pairingIdentityPath = process.env.VERITY_PAIRING_IDENTITY_KEY_PATH;
  const pairingCodePath = process.env.VERITY_PAIRING_CODE_PATH;
  const pairingExpiresAt = process.env.VERITY_PAIRING_EXPIRES_AT;
  const pairingExpiresAtPath = process.env.VERITY_PAIRING_EXPIRES_AT_PATH;
  if (pairingExpiresAt && pairingExpiresAtPath) {
    throw new Error(
      'VERITY_PAIRING_EXPIRES_AT and VERITY_PAIRING_EXPIRES_AT_PATH are mutually exclusive',
    );
  }
  const resolvedPairingExpiresAt = pairingExpiresAtPath
    ? (await readFile(pairingExpiresAtPath, 'utf8')).trim()
    : pairingExpiresAt;
  const pairingParts = [pairingIdentityPath, pairingCodePath, resolvedPairingExpiresAt].filter(
    (value) => value !== undefined && value !== '',
  );
  if (pairingParts.length !== 0 && pairingParts.length !== 3) {
    throw new Error(
      'VERITY_PAIRING_IDENTITY_KEY_PATH, VERITY_PAIRING_CODE_PATH and one pairing expiry source must be configured together',
    );
  }
  const devicePairing =
    pairingParts.length === 3
      ? createDevicePairingManager({
          privateKeyPem: await readFile(pairingIdentityPath!, 'utf8'),
          loadPairingMaterial: () => ({
            pairingCode: readFileSync(pairingCodePath!, 'utf8').trim(),
            expiresAt: pairingExpiresAtPath
              ? readFileSync(pairingExpiresAtPath, 'utf8').trim()
              : resolvedPairingExpiresAt!,
          }),
          loadConsumedCodeHash: () => {
            const hashes = new Set<string>();
            try {
              for (const hash of readFileSync(join(verityRoot, '.pairing-code-consumed'), 'utf8')
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean)) {
                hashes.add(hash);
              }
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            try {
              for (const hash of readdirSync(join(verityRoot, '.pairing-code-consumed.d'))) {
                hashes.add(hash);
              }
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            return [...hashes];
          },
          storeConsumedCodeHash: (hash) => {
            const directory = join(verityRoot, '.pairing-code-consumed.d');
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            try {
              const fd = openSync(join(directory, hash), 'wx', 0o600);
              closeSync(fd);
              return true;
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
              throw error;
            }
          },
        })
      : undefined;
  // In managed mode the public Gateway terminates TLS; its backend remains on
  // the private Compose network over HTTP. Direct deployments terminate here.
  const managedDeployment = Boolean(process.env.VERITY_MANAGED_DEPLOYMENT_ID?.trim());
  const configuredTlsMode = process.env.VERITY_TLS_MODE?.trim();
  const tlsMode = configuredTlsMode === '' ? undefined : configuredTlsMode;
  if (tlsMode !== undefined && tlsMode !== 'direct' && tlsMode !== 'backend') {
    throw new Error('VERITY_TLS_MODE must be direct or backend');
  }
  const backendTls =
    !directServerMode && (tlsMode === 'backend' || (tlsMode === undefined && managedDeployment));
  const configuredTls = await tlsFromEnvironment();
  const https = backendTls ? undefined : configuredTls;
  if (directServerMode && https === undefined) {
    throw new Error('direct-server mode requires TLS key and certificate paths');
  }
  const managedTls = backendTls ? configuredTls : undefined;

  /** The build itself, split out only so the failure unwind above can wrap it. */
  const buildAndListen = async (context: {
    controlPlane: ClaimedControlPlane | undefined;
    adoptedSecretKeyMaterial: string | undefined;
    unwind: (started?: EmbeddedServer, internal?: InternalListener) => Promise<void>;
    built: { server?: EmbeddedServer; internal?: InternalListener };
  }): Promise<ServingStack> => {
    const { controlPlane, adoptedSecretKeyMaterial } = context;
    const serverPromise = buildEmbeddedServer({
      databaseUrl,
      ...(managedTls === undefined
        ? {}
        : {
            unlockClientIdentity: (request) =>
              verifyManagedClientIdentity(
                managedClientIdentitySecret(managedTls.key),
                request.headers[MANAGED_CLIENT_IDENTITY_HEADER],
                { method: request.method, url: request.raw.url ?? '/' },
              ),
          }),
      ...(https === undefined ? {} : { https }),
      ...(devicePairing === undefined ? {} : { devicePairing }),
      ...(controlPlane === undefined ? {} : { controlPlaneFence: controlPlane.held }),
      ...(adoptedSecretKeyMaterial === undefined ? {} : { adoptedSecretKeyMaterial }),
      secretMaterializationRoot: join(verityRoot, 'secrets'),
      workspacesDir: join(verityRoot, 'sessions'),
      // The project repo a spawned agent branches from (isolated worktrees per
      // session) AND the repo-root checkout reserved for the human/main session,
      // which the server never provisions or removes (#105). Defaults to the git
      // repo root (e.g. /work), not the server's cwd (packages/server). Set
      // VERITY_REPO_DIR='' to disable (scratch worktrees, no repo-root guard).
      repoDir: process.env.VERITY_REPO_DIR ?? gitToplevel() ?? process.cwd(),
      // Token provider for the header's open-PR lookup (#125, #131). Reads the fleet's
      // rotating `~/.gh-token` (refreshed hourly by heey-token-mint) freshly per lookup
      // so the lookup keeps working past the 1h token life without a restart, falling
      // back to a static PAT in the env (GITHUB_TOKEN / GH_TOKEN) when there's no file.
      // The provider form means the secret is never captured once at startup; absent
      // everywhere → the PR chip is simply disabled. Never logged.
      // Git committer identity is NOT configured via env — it is derived from the
      // GitHub App installation during signing-key onboarding (see
      // resolveGitHubAppIdentity), so no VERITY_GIT_USER_NAME/EMAIL knobs exist.
      githubToken: createGhTokenReader({
        path: ghTokenFilePath,
        env: () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      }),
      workflowGithubWebhookSecret: process.env.VERITY_GITHUB_WEBHOOK_SECRET,
      authorizeWorkflowAction:
        process.env.VERITY_WORKFLOW_ALLOW_PAIRED_DEVICES === '1' ||
        process.env.VERITY_WORKFLOW_ALLOW_PAIRED_DEVICES === 'true'
          ? (actorId, action) =>
              Promise.resolve(
                actorId !== 'local-control-plane' &&
                  (action !== 'service:write' ||
                    process.env.VERITY_WORKFLOW_ALLOW_REGISTRY_WRITES === '1' ||
                    process.env.VERITY_WORKFLOW_ALLOW_REGISTRY_WRITES === 'true'),
              )
          : undefined,
      workflowArgoCdBaseUrl: process.env.VERITY_ARGOCD_BASE_URL,
      workflowArgoCdToken: process.env.VERITY_ARGOCD_TOKEN,
      // HTTP socket-proxy URL (`http://127.0.0.1:9234/v1.41`) OR, for a standalone
      // runner with the host socket mounted, `unix:///var/run/docker.sock`
      // (optionally `…:/v1.41`). A `unix://` value selects the mounted-socket
      // transport in createDockerClient (ADR 0003 R2). Passed through unchanged.
      dockerBaseUrl: process.env.VERITY_DOCKER_BASE_URL,
      publicPreviews: {
        resolveConnectorImage: () =>
          resolveWithTimeout(
            () =>
              resolvePublicOciTagDigest(
                releasePinnedRef(PREVIEW_CONNECTOR_IMAGE_REPO, 'v') ??
                  `${PREVIEW_CONNECTOR_IMAGE_REPO}:latest`,
              ),
            10_000,
          ).catch(() => undefined),
        uplinkUrl: UPLINK_CONTROL_URL,
        serverVersion: SERVER_VERSION,
      },
      secretJobRuntimeRequired:
        process.env.VERITY_SECRET_JOB_RUNTIME_REQUIRED === '1' ||
        process.env.VERITY_SECRET_JOB_RUNTIME_REQUIRED === 'true',
      // Optional private-registry auth for base-image pulls (ADR 0003 R6 / #299):
      // base64 JSON {username,password} or an identity token → X-Registry-Auth.
      // Unset for the public ghcr base image (the default). Never logged.
      registryAuth: process.env.VERITY_REGISTRY_AUTH,
      hostCloneRoot: join(verityRoot, 'workspaces'),
      // Named data volume (M16). Mandatory because relay Unix sockets and project
      // mounts must resolve by the same volume name in sibling containers.
      // VERITY_ROOT and names it here, so per-project mounts become volume subpaths
      // (resolved by name on the host daemon) instead of host binds — no host dir to
      // create/chown. Deploy plumbing, not an operator toggle.
      dataVolume,
      dataVolumeRoot: verityRoot,
      // Host-disk GC (docker-gc.ts). ON unless explicitly disabled: the two caches
      // it collects are Verity's own and are append-only without it, so "off" is a
      // slow disk-full, not a safe default. Set VERITY_DOCKER_GC=0 only when an
      // external janitor owns this host's Docker disk.
      dockerGc: process.env.VERITY_DOCKER_GC !== '0' && process.env.VERITY_DOCKER_GC !== 'false',
      dockerGcPolicy: dockerGcPolicyFromEnv(),
      agentSeedHostPath: sandboxAgentSeedHostPath(process.env),
      ghTokenFilePath,
      // Anti-CSWSH Origin allowlist for the live WebSocket (audit C1). Comma-list,
      // e.g. `https://verity.example.com`. Unset → no Origin check (native mobile
      // sends none; the bearer token is the primary guard).
      wsAllowedOrigins: splitList(process.env.VERITY_ALLOWED_ORIGINS),
      // The gateway carries every Claude project turn, so neither of these may depend on
      // a host pre-provisioning them: the control socket has one correct value the
      // gateway process itself already defaults to, and the unseal material is held only
      // by the Server, so the Server generates and persists it on first use. Both stay
      // overridable for non-standard topologies.
      agentGatewayControlSocket:
        process.env.VERITY_AGENT_GATEWAY_CONTROL_SOCKET?.trim() ||
        DEFAULT_AGENT_GATEWAY_CONTROL_SOCKET,
      agentGatewayUnsealKey: resolveAgentGatewayUnsealKey(verityRoot),
      agentGatewayUrl: process.env.VERITY_AGENT_GATEWAY_URL?.trim() || undefined,
      agentGatewayClaudePort: parsePort(process.env.VERITY_AGENT_GATEWAY_CLAUDE_PORT, 9443),
      // Every project relay has a fixed Claude upstream, and every Claude project
      // turn is routed through the Agent Gateway — the coordinates are always
      // present so relay construction has no partial/optional state.
      claudeEgressGatewayUrl: process.env.VERITY_CLAUDE_EGRESS_GATEWAY_URL ?? 'https://verity:9443',
      codexEgressGatewayUrl:
        process.env.VERITY_CODEX_EGRESS_GATEWAY_URL ?? 'https://verity-agent-gateway:9444',
      claudeConnectorPort: parseNonNegativeInt(process.env.VERITY_CLAUDE_CONNECTOR_PORT) ?? 47_821,
      claudeEgressServerName: process.env.VERITY_CLAUDE_EGRESS_SERVER_NAME,
      claudeEgressGatewayHost: process.env.VERITY_CLAUDE_EGRESS_GATEWAY_HOST,
      projectRelayImage,
      projectRelayGid,
      // Sandbox runtime hardening (security review C1). The provisioner drops all
      // caps, blocks privilege escalation, and defaults to 512 PIDs, 4 GiB memory
      // with swap disabled, and 2 CPU cores. These env knobs tune those ceilings.
      // A devcontainer that needs sudo can set
      // VERITY_SANDBOX_ALLOW_PRIVILEGE_ESCALATION=1 (or add caps via CAP_ADD).
      sandboxPidsLimit: parseNonNegativeInt(process.env.VERITY_SANDBOX_PIDS_LIMIT),
      sandboxMemoryBytes: parseByteSize(process.env.VERITY_SANDBOX_MEMORY),
      sandboxNanoCpus: parseCpuCores(process.env.VERITY_SANDBOX_CPUS),
      sandboxCapAdd: splitList(process.env.VERITY_SANDBOX_CAP_ADD),
      sandboxAllowPrivilegeEscalation:
        process.env.VERITY_SANDBOX_ALLOW_PRIVILEGE_ESCALATION === '1' ||
        process.env.VERITY_SANDBOX_ALLOW_PRIVILEGE_ESCALATION === 'true',
      // Wire the `/internal/*` origin gate when a dedicated internal listener is
      // configured (started below). Kept in sync via the single VERITY_INTERNAL_PORT.
      internalPort,
      defaultProjectImage,
      defaultProjectImageVersion,
      devcontainerFeatureRef,
      // The resolver above hides which of the two it is; say it out loud, or the
      // digest this process resolved for itself would pass for an operator's pin
      // and outrank the Feature baked into this image.
      devcontainerFeatureRefConfigured: toolkitFeatureRefIsConfigured(
        process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF,
      ),
      claudeConfigVolume: process.env.VERITY_CLAUDE_CONFIG_VOLUME,
      codexConfigVolume: process.env.VERITY_CODEX_CONFIG_VOLUME,
      enableProjectRuntime: process.env.VERITY_ENABLE_PROJECT_RUNTIME === '1',
      // Opt-in event-file + control-socket runner transport (ADR 0006 Stage 2.2-prep).
      // Default OFF ⇒ the conductor's in-process loopback dispatch is unchanged.
      runnerTransport: process.env.VERITY_RUNNER_TRANSPORT === '1',
      runnerSupervisor:
        process.env.VERITY_RUNNER_SUPERVISOR === '1' ||
        process.env.VERITY_RUNNER_SUPERVISOR === 'true',
      controlPlaneRunner:
        process.env.VERITY_CONTROL_PLANE_RUNNER === '1' ||
        process.env.VERITY_CONTROL_PLANE_RUNNER === 'true',
      // Unset sweeps; `dry`/`off` are the opt-outs. A typo throws — see the parser.
      transcriptSweep: parseTranscriptSweep(process.env.VERITY_TRANSCRIPT_SWEEP),
      controlPlaneRunnerIdentityDir:
        process.env.VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR?.trim() || undefined,
      runnerRuntimeGid,
      // An explicit deployment-wide image override is arbitrary code and cannot
      // inherit the managed Verity sandbox's dedicated-UID boundary assertion.
      runnerSupervisorTrustedDefaultImage:
        process.env.VERITY_DEFAULT_PROJECT_IMAGE === undefined ||
        process.env.VERITY_DEFAULT_PROJECT_IMAGE.trim().length === 0,
      permissionMode: process.env.VERITY_PERMISSION_MODE,
      // OpenCode over ACP in the project Sandbox (#143, ADR 0012 Amendment 4) —
      // turns on a provider-qualified model (`deepinfra/…`) route there; unset →
      // Claude-only. Opt-in rather than default-on because the picker's OpenCode
      // entries are the operator's own `VERITY_EXTRA_MODELS` list: a deployment
      // that has not named any models has nothing to route.
      // A still-set `OPENCODE_BASE_URL` stops the boot — see the parser. Worth being
      // explicit about how far that goes: the throw here is not scoped to OpenCode, it
      // aborts `main()` and the whole Server with it, so Claude and Codex sessions stay
      // down until the variable is answered for. That is the intended trade for exactly
      // one upgrade: a stale variable that silently did nothing would leave a deployment
      // believing it still has the shared `opencode serve` it configured, and the fix is
      // one edit to the env file. It surfaces on stderr through the generic
      // `verity: failed to start` arm at the bottom of this file — with a stack trace,
      // unlike the advisory-lock case, because a bad env value is a configuration bug the
      // operator has to correct rather than a well-formed refusal.
      openCodeEnabled: parseOpenCodeEnabled(
        {
          enabled: process.env.VERITY_OPENCODE_ENABLED,
          legacyBaseUrl: process.env.OPENCODE_BASE_URL,
        },
        (message) => console.warn(message),
      ),
      codexEnabled: process.env.CODEX_ENABLED !== '0',
      // Codex runs over ACP and receives brokered tools through the MCP gateway.
      codexModels: splitList(process.env.CODEX_MODELS),
      extraModels: splitList(process.env.VERITY_EXTRA_MODELS),
      // GitHub Projects v2 board backing task management (ADR 0007). Unset → the
      // `/tasks` routes 503 and the mobile Plan tab hides; set to the board number
      // (with `repoDir` + a GitHub token) to activate it.
      tasksProjectNumber: parseTasksProjectNumber(process.env.VERITY_TASKS_PROJECT_NUMBER),
      // Expo's push API is unauthenticated by default. An access token is only
      // required when Enhanced Push Security is enabled for the EAS project, so
      // self-hosted Verity servers can send out of the box. Keep an explicit
      // opt-out for deployments that do not want device push registration.
      pushEnabled: parsePushEnabled(process.env.VERITY_PUSH_ENABLED),
      // A sandbox provisioned before an env block grew cannot reach what that block
      // configures — for Codex, every request comes back 502 — and rebuilding it is
      // the only repair. On by default for that reason. The opt-out is here because
      // the first deploy of a new cohort rebuilds every drifted sandbox in the fleet
      // at once, and a deployment should be able to stop that without a rollback.
      recreateEnvDriftedSandboxes: parseDefaultOnFlag(
        process.env.VERITY_RECREATE_ENV_DRIFTED_SANDBOXES,
        'VERITY_RECREATE_ENV_DRIFTED_SANDBOXES',
      ),
      expoAccessToken: process.env.EXPO_ACCESS_TOKEN?.trim() || undefined,
      // Google Drive OAuth iOS client id (ADR 0009), baked in at image build time.
      googleDriveClientId: process.env.GOOGLE_AUTH_ID?.trim() || undefined,
      // Signed stable release channel (ADR 0008 D4). On a host architecture no
      // release is published for, the resolver reports `unsupported` with that as
      // the reason rather than advertising a release this machine could not run.
      serverUpdateResolver: buildReleaseChannelResolver(releaseArchitecture, verityRoot),
      // Announcing a release is what makes anyone look; D11 keeps the decision.
      serverUpdateNotifierStatePath: serverUpdateNotifierStatePath(verityRoot),
      // The action side of the same feature: present when the sealed spec gave
      // this Server the Updater's control mount (ADR 0008 D2). Whether the
      // Updater is listening on it right now is answered per request, not here.
      serverUpdateController,
      logger: true,
    });
    onStartupFailure(async () => {
      await context.unwind(await serverPromise.catch(() => undefined));
    });
    const server = await serverPromise;
    context.built.server = server;
    log = server.app.log;
    onStartupFailure(async () => {
      await context.unwind(server);
    });
    await stopStartupIfRequested();

    await server.app.listen({ port, host });
    await stopStartupIfRequested();

    // Start the dedicated `/internal/*` listener (opt-in). It shares the Fastify
    // handler but is a separate, non-published socket, so the broker is reachable
    // only here — the public port 404s `/internal/*` (see internalPathGuard).
    let internalListener: InternalListener | undefined;
    if (internalPort !== undefined) {
      internalListener = await startInternalListener(server.app, internalPort, internalHost);
      context.built.internal = internalListener;
      onStartupFailure(async () => {
        await context.unwind(server, internalListener);
      });
      await stopStartupIfRequested();
      server.app.log.info(
        { internalPort: internalListener.port, internalHost },
        'verity: /internal/* served on a dedicated non-published listener',
      );
    }

    // A non-loopback bind exposes the control plane to the network. The master-
    // password auth gate is the real protection (and ideally TLS in front); flag a
    // routable bind so an accidental `HOST=0.0.0.0` over plain HTTP is not silent.
    const routableBind = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
    if (routableBind && https === undefined) {
      server.app.log.warn(
        { host, port },
        'verity: control plane bound to a non-loopback interface over plain HTTP — ' +
          'the bearer token and master password travel in cleartext on that network, ' +
          'so reach it only through a trusted segment (behind the firewall / over a VPN)',
      );
    }

    // Giving the control plane up. There is no safe way to keep serving once
    // authority cannot be shown to be ours, so this process stops rather than
    // risk two control planes writing to one database. Note that this is NOT
    // what a quiesced standby does — that one gives the generation up itself and
    // stays alive.
    //
    // Each branch below states only what was actually established. The third one
    // is the reason this is a switch at all: a database that stayed unreachable
    // for the whole reconnect budget proves nothing about who holds anything,
    // and saying otherwise sends an operator looking for a second Server that
    // does not exist.
    const controlPlaneHold: ControlPlaneHold | undefined = controlPlane?.hold;
    controlPlane?.onLost((loss) => {
      const generation = controlPlane.held.generation;
      if (loss.kind === 'process-lock-taken')
        server.app.log.error(
          { generation },
          'verity: another Server took the PostgreSQL control-plane process lock — shutting down',
        );
      else if (loss.kind === 'generation-taken')
        server.app.log.error(
          { generation },
          'verity: the control-plane generation is held by another Server — shutting down',
        );
      else if (loss.kind === 'unreachable')
        server.app.log.error(
          { generation, err: loss.error },
          'verity: could not re-prove control-plane authority — PostgreSQL stayed unreachable ' +
            'for the whole reconnect budget. NO takeover was observed; shutting down so a ' +
            'supervised restart can re-establish authority against a database that answers',
        );
      else
        server.app.log.error(
          { generation, err: loss.error },
          'verity: the control-plane keeper failed for a reason that proves nothing about ' +
            'ownership — NO takeover was observed. Shutting down; the logged error is the ' +
            'cause to fix, and is far more likely configuration than a second Server',
        );
      onFenceLost();
    });

    if (controlPlane !== undefined)
      server.app.log.info(
        { generation: controlPlane.held.generation, holderId: controlPlane.held.holderId },
        'verity: holding the control-plane generation',
      );

    if (agentSeedProvenance !== undefined)
      reportAgentSeedProvenance(agentSeedProvenance, server.app.log);

    return {
      exportKeyMaterial: () => server.secretKeyHandoff.exportKeyMaterial(),
      /**
       * The ordered stop the whole design rests on: serving first, authority last.
       *
       * A successor may only take the exclusive PostgreSQL lock once every shared
       * hold here is gone, and those live on the serving pool's connections — so
       * closing the embedded server (which destroys that pool) has to complete
       * before the generation is handed back and the keeper lock released. Run for
       * a quiescing standby exactly as for a stopping process; the difference is
       * only whether anything starts again afterwards.
       */
      close: async (mode) => {
        // Stop accepting new internal requests first, then close the main server.
        await internalListener?.close();
        await server.close({ preserveProjectRelays: mode === 'handoff' });
        // Handing the generation back is the last thing this incarnation does, so
        // a successor can only compare-and-swap its way in once nothing here is
        // still serving. `release` reports rather than throws when the fence is
        // already gone, which at this point is information, not a failure.
        if (controlPlaneHold !== undefined && !(await controlPlaneHold.release()))
          server.app.log.warn('verity: control-plane generation was already held elsewhere');
        await controlPlane?.close();
      },
    };
  };

  const lifecycle = createStandbyLifecycle(await startServingStack({}), {
    start: startServingStack,
  });

  let shutdownStarted = false;
  const shutdown = (signal: NodeJS.Signals | 'fence-lost'): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log?.info({ signal }, 'verity: shutting down');
    void (async () => {
      try {
        // Nothing left to hand the key to once this process is going away, and
        // no directive worth following: a standby that is being stopped is not
        // one anything can roll back to.
        handoffResponder?.stop();
        standbyFollower?.stop();
        // Closes whatever is still open — a serving stack, or nothing at all if
        // this process was already a quiesced standby when the signal arrived.
        await lifecycle.stop();
        // Authority loss is not a clean administrative stop. A supervisor using
        // an on-failure policy must restart this Server (which will either regain
        // the process lock or keep refusing while its successor owns it).
        process.exit(signal === 'fence-lost' ? 1 : 0);
      } catch (error: unknown) {
        log?.error({ err: error }, 'verity: error during shutdown');
        process.exit(1);
      }
    })();
  };
  onFenceLost = () => {
    shutdown('fence-lost');
  };

  // Carry the unlocked data key to the Server this one is being replaced by
  // (ADR 0008 D8), so an update the operator asked for once does not end at a
  // master-password prompt. Read through the lifecycle rather than from one
  // incarnation: a standby that has quiesced still holds the key, and that is
  // exactly the window in which a successor asks for it. A failure here costs
  // the successor nothing but the prompt it would have had anyway.
  if (secretKeyHandoffClient !== undefined) {
    handoffResponder = startSecretKeyHandoffResponder({
      client: secretKeyHandoffClient,
      readKeyMaterial: () => lifecycle.keyMaterial(),
      isActive: () => !shutdownStarted,
      onHandedOff: () => {
        log?.info('verity: secret store key sealed for the next generation');
      },
      onError: (error: unknown) => {
        log?.debug({ err: error }, 'verity: secret-key handoff step failed');
      },
    });
  }

  // Follow the Updater's standby directive (ADR 0008 D9): give the control
  // plane up when a cutover asks, take it back when a rollback does — without
  // this process ending, which is what lets the maintenance window close on a
  // Server that is still there to return to. Started last, so nothing can
  // quiesce a stack that is not finished being built.
  if (standbyDirectiveClient !== undefined) {
    standbyFollower = startStandbyFollower({
      client: standbyDirectiveClient,
      lifecycle,
      operationId: process.env.VERITY_UPDATE_ID?.trim() || undefined,
      onStep: (step) => {
        if (step === 'quiesced')
          log?.info('verity: quiesced as a standby — holding no control plane, still alive');
        if (step === 'resumed')
          log?.info('verity: resumed serving under a new control-plane generation');
      },
      onError: (error: unknown) => {
        log?.debug({ err: error }, 'verity: standby directive step failed');
      },
    });
  }

  process.removeListener('SIGINT', stopDuringStartup);
  process.removeListener('SIGTERM', stopDuringStartup);
  // Startup is over: a later failure inside `startServingStack` belongs to a
  // resume, which unwinds itself.
  startupBuilding = false;
  cleanupStartup = () => Promise.resolve();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error: unknown) => {
  await cleanupStartup().catch(() => undefined);
  cleanupStartup = () => Promise.resolve();
  // Refusing to start because another Server owns the control plane is a
  // correct outcome, not a crash. A stack trace here would send an operator
  // looking for a bug instead of for the other Server.
  if (error instanceof PostgresAdvisoryLockHeldError) {
    console.error(`verity: refusing to start — ${error.message}`);
    process.exit(1);
  }
  console.error('verity: failed to start', error);
  process.exit(1);
});
