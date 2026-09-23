import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import {
  type EventStore,
  type PublicPreviewShareRecord,
  type PublicPreviewShareState,
} from '@verity/store';
import { DockerError, type DockerClient } from './docker.js';
import { SIGNING_BROKER_TOKEN_HASH_LABEL } from './git-signer.js';
import { PROJECT_RUNSC_RUNTIME } from './gvisor-runtime-config.js';
import { containerGenerationOf } from './project-relay-migration.js';
import {
  codexGatewayConfig,
  projectClonePath,
  projectNetworkName,
  RUNNER_AGENT_UID,
  RUNNER_BROKER_CAPABILITIES,
} from './provisioner.js';
import { relative, posix, resolve, join } from 'node:path';

const COMPONENT_LABEL = 'verity.component';
const SHARE_LABEL = 'verity.public-preview-share-id';
const PROJECT_LABEL = 'verity.project-id';
const GENERATION_LABEL = 'verity.container-generation';
const DEV_SERVER_LABEL = 'verity.dev-server-id';
const ACTIVE_STATES: readonly PublicPreviewShareState[] = ['creating', 'active', 'revoking'];
const CREATING_LEASE_MS = 2 * 60_000;
const CONNECTOR_READY_TIMEOUT_MS = 15_000;
const CONNECTOR_READY_POLL_MS = 250;
const CONNECTOR_READY_MARKER = 'preview connector established';
const MIN_PREVIEW_TTL_SECONDS = 15 * 60;
const MAX_PREVIEW_TTL_SECONDS = 8 * 60 * 60;

export interface PreviewEdgeCreate {
  pinHash: string;
  durationSeconds: number;
}

export interface PreviewEdgeBinding {
  shareId: string;
  publicOrigin: string;
  edgeUrl: string;
  connectorToken: string;
  sessionSecret: string;
  expiresAt: Date;
}

/** The Uplink owns the public edge and its routing; this installation names no
 * cluster objects and holds no cluster credentials (ADR 0012 D1/D8). Calls must
 * be idempotent by shareId.
 *
 * `publicOrigin` still travels outward here because the manager derives the
 * share hostname locally, while the protocol has the Uplink assign it and return
 * it in `share.ready`. Reversing that is part of building the Uplink client, not
 * something this interface can express today — see the contract gaps in
 * `docs/handoffs/PUBLIC_PREVIEW_UPLINK_HANDOFF.md`. */
export interface PreviewEdgeControl {
  create(input: PreviewEdgeCreate): Promise<PreviewEdgeBinding>;
  remove(shareId: string): Promise<void>;
  isAvailable?(): boolean;
}

export interface PreviewShareManagerOptions {
  store: EventStore;
  docker: DockerClient;
  edge: PreviewEdgeControl;
  resolveConnectorImage: () => Promise<string | undefined>;
  dataVolume?: string;
  dataVolumeRoot?: string;
  hostCloneRoot?: string;
  isDevServerRunning: (input: {
    project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>;
    devServer: NonNullable<Awaited<ReturnType<EventStore['getDevServer']>>>;
  }) => Promise<boolean>;
  now?: () => Date;
  connectorReadyTimeoutMs?: number;
  connectorReadyPollMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  inspectArtifact?: (
    path: string,
    readContents?: boolean,
  ) => Promise<{
    uid: number;
    gid: number;
    mode: number;
    kind: 'file' | 'directory';
    contents?: string;
  }>;
  listArtifactDirectory?: (path: string) => Promise<string[]>;
}

export interface CreatePreviewShareInput {
  projectId?: string;
  devServerId?: string;
  staticPath?: string;
  pin: string;
  ttlSeconds: number;
}

export interface PublicPreviewShare {
  id: string;
  projectId: string;
  devServerId: string | null;
  targetKind: 'dev-server' | 'static-folder';
  staticPath: string | null;
  state: PublicPreviewShareState;
  publicOrigin: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  failure: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PreviewShareManager {
  private readonly creations = new Map<string, Promise<void>>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private connectorImage: string | undefined;

  constructor(private readonly options: PreviewShareManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  isAvailable(): boolean {
    return this.options.edge.isAvailable?.() ?? true;
  }

  async create(input: CreatePreviewShareInput): Promise<PublicPreviewShare> {
    const devServer = input.devServerId
      ? await this.options.store.getDevServer(input.devServerId)
      : undefined;
    if (input.devServerId !== undefined && !devServer) {
      throw new PreviewShareNotFoundError('dev server not found');
    }
    const projectId = devServer?.projectId ?? input.projectId;
    if (!projectId) throw new PreviewShareInputError('projectId is required for a static folder');
    return this.withLifecycleLocks(
      [`project:${projectId}`, ...(devServer ? [`dev-server:${devServer.id}`] : [])],
      () => this.createLocked(input),
    );
  }

  private async createLocked(input: CreatePreviewShareInput): Promise<PublicPreviewShare> {
    if (!/^\d{6,12}$/.test(input.pin)) {
      throw new PreviewShareInputError('PIN must contain 6 to 12 digits');
    }
    if (
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < MIN_PREVIEW_TTL_SECONDS ||
      input.ttlSeconds > MAX_PREVIEW_TTL_SECONDS
    ) {
      throw new PreviewShareInputError('TTL must be between 15 minutes and 8 hours');
    }
    const isStatic = input.staticPath !== undefined;
    if (isStatic === (input.devServerId !== undefined)) {
      throw new PreviewShareInputError('choose exactly one dev server or static folder');
    }
    const devServer = input.devServerId
      ? await this.options.store.getDevServer(input.devServerId)
      : undefined;
    if (!isStatic && !devServer) throw new PreviewShareNotFoundError('dev server not found');
    if (devServer && (!devServer.containerPort || !validPort(devServer.containerPort))) {
      throw new PreviewShareConflictError('dev server has no valid container port');
    }
    const projectId = devServer?.projectId ?? input.projectId;
    if (!projectId) throw new PreviewShareInputError('projectId is required');
    const project = await this.options.store.getProject(projectId);
    if (!project) throw new PreviewShareNotFoundError('project not found');
    if (project.state !== 'active') throw new PreviewShareConflictError('project is not active');
    if (devServer && !(await this.options.isDevServerRunning({ project, devServer }))) {
      throw new PreviewShareConflictError('dev server is not running');
    }
    const staticPath = isStatic ? normalizedStaticPath(input.staticPath!) : null;
    const existing = (await this.options.store.listPublicPreviewShares(project.id)).some(
      (share) =>
        ACTIVE_STATES.includes(share.state) &&
        (devServer ? share.devServerId === devServer.id : share.staticPath === staticPath),
    );
    if (existing) throw new PreviewShareConflictError('target already has an active public share');
    if (staticPath) await this.validateStaticDirectory(project, staticPath);

    const sandbox = await this.options.docker.inspectContainer(project.containerName);
    const generation = containerGenerationOf(sandbox);
    if (!sandbox.running || !generation) {
      throw new PreviewShareConflictError('sandbox is not running with a relay generation');
    }
    const workspaceSubpath = projectWorkspaceSubpath(project, this.options);
    await assertEligibleSandbox(
      sandbox,
      projectNetworkName(project.id),
      project.id,
      workspaceSubpath,
      this.options,
    );
    const staticMount = isStatic ? this.staticMount(project) : undefined;

    if (this.options.edge.isAvailable?.() === false) {
      throw new PreviewShareConflictError(
        'public previews are not entitled or the Uplink is offline',
      );
    }
    const connectorImage = await this.resolveConnectorImage();
    const pinHash = await hashPin(input.pin);
    const binding = await this.options.edge.create({
      pinHash,
      durationSeconds: input.ttlSeconds,
    });
    let shareId: string;
    try {
      shareId = validShareId(binding.shareId);
    } catch (error) {
      // Even a contract-violating id is the only handle for the object the Uplink
      // just created. Revoke bounded strings before rejecting the response.
      if (
        typeof binding.shareId === 'string' &&
        binding.shareId.length > 0 &&
        binding.shareId.length <= 256
      ) {
        await this.options.edge.remove(binding.shareId).catch(() => undefined);
      }
      throw error;
    }
    let connectorToken: string;
    let sessionSecret: string;
    let publicOrigin: string;
    let edgeUrl: string;
    try {
      connectorToken = validSecret(binding.connectorToken, 'connector token');
      sessionSecret = validSecret(binding.sessionSecret, 'session secret');
      publicOrigin = normalizedHttps(binding.publicOrigin);
      edgeUrl = normalizedEdgeUrl(binding.edgeUrl, publicOrigin);
      this.assertEdgeAvailable();
    } catch (error) {
      await this.options.edge.remove(shareId).catch(() => undefined);
      throw error;
    }
    const connectorContainerName = `verity-preview-${shareId}`;
    const expiresAt = binding.expiresAt;
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= this.now().getTime() ||
      expiresAt.getTime() > this.now().getTime() + input.ttlSeconds * 1000 + 60_000
    ) {
      await this.options.edge.remove(shareId).catch(() => undefined);
      throw new Error('Uplink returned an invalid share expiry');
    }
    const recordInput: Parameters<EventStore['createPublicPreviewShare']>[0] = {
      id: shareId,
      projectId: project.id,
      devServerId: devServer?.id ?? null,
      containerGeneration: generation,
      targetPort: devServer ? Number(devServer.containerPort) : null,
      targetKind: devServer ? 'dev-server' : 'static-folder',
      staticPath,
      publicOrigin,
      edgeUrl,
      pinHash,
      connectorToken,
      sessionSecret,
      connectorContainerName,
      expiresAt,
    };
    let record: PublicPreviewShareRecord;
    try {
      this.assertEdgeAvailable();
      record = await this.options.store.createPublicPreviewShare(recordInput);
    } catch (error) {
      const removal = await Promise.allSettled([this.options.edge.remove(shareId)]);
      if (removal[0]?.status === 'rejected') {
        // Once the Uplink has minted a share, a failed remote revoke must leave
        // a durable local retry handle. The initial insert may have failed after
        // committing, so inspect first and only retry the same id when absent.
        let recovery = await this.options.store
          .getPublicPreviewShare(shareId)
          .catch(() => undefined);
        if (!recovery) {
          recovery = await this.options.store
            .createPublicPreviewShare(recordInput)
            .catch(() => undefined);
        }
        if (recovery) {
          await this.options.store.transitionPublicPreviewShare(shareId, ['creating'], 'revoking', {
            failure: safeFailure(error),
          });
        }
        throw new AggregateError(
          [error, removal[0].reason],
          recovery
            ? 'public preview persistence failed; remote cleanup is queued for reconciliation'
            : 'public preview persistence and remote cleanup failed without a durable recovery row',
          { cause: error },
        );
      }
      const winner = (await this.options.store.listPublicPreviewShares(project.id)).some(
        (share) =>
          ACTIVE_STATES.includes(share.state) &&
          (devServer ? share.devServerId === devServer.id : share.staticPath === staticPath),
      );
      if (winner) {
        throw new PreviewShareConflictError('dev server already has an active public share', {
          cause: error,
        });
      }
      throw error;
    }

    let connectorId: string | undefined;
    let becameActive = false;
    let finishCreation!: () => void;
    const creationFinished = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    this.creations.set(shareId, creationFinished);
    try {
      this.assertEdgeAvailable();
      // External calls above leave a race window after the initial path check.
      // Revalidate at the mount boundary so a swapped ancestor cannot be handed
      // to Docker as the connector's static source.
      if (staticPath) await this.validateStaticDirectory(project, staticPath);
      connectorId = await this.createConnector(
        record,
        project.containerName,
        connectorImage,
        staticMount,
      );
      const after = await this.options.docker.inspectContainer(project.containerName);
      if (!after.running || containerGenerationOf(after) !== generation) {
        throw new Error('sandbox generation changed while the share was being created');
      }
      await assertEligibleSandbox(
        after,
        projectNetworkName(project.id),
        project.id,
        workspaceSubpath,
        this.options,
      );
      if (devServer) {
        const currentDevServer = await this.options.store.getDevServer(devServer.id);
        if (
          !currentDevServer ||
          devServerLifecycleKey(currentDevServer) !== devServerLifecycleKey(devServer)
        ) {
          throw new Error('dev server changed while the share was being created');
        }
        if (!(await this.options.isDevServerRunning({ project, devServer: currentDevServer }))) {
          throw new Error('dev server stopped while the share was being created');
        }
      }
      this.assertEdgeAvailable();
      const active = await this.options.store.transitionPublicPreviewShare(
        shareId,
        ['creating'],
        'active',
        { connectorContainerId: connectorId },
      );
      if (!active) throw new Error('share was revoked while it was being created');
      becameActive = true;
      this.assertEdgeAvailable();
      return publicShare(active);
    } catch (error) {
      const cleanup = await Promise.allSettled([
        connectorId
          ? removeContainer(this.options.docker, connectorId)
          : removeContainer(this.options.docker, connectorContainerName),
        this.options.edge.remove(shareId),
      ]);
      const cleanupFailures: unknown[] = [];
      for (const result of cleanup) {
        if (result.status === 'rejected') cleanupFailures.push(result.reason);
      }
      if (cleanupFailures.length > 0) {
        await this.options.store.transitionPublicPreviewShare(
          shareId,
          becameActive ? ['active'] : ['creating'],
          'revoking',
          { failure: safeFailure(error) },
        );
        throw new AggregateError(
          [error, ...cleanupFailures],
          'public preview setup failed and cleanup was incomplete',
          { cause: error },
        );
      }
      await this.options.store.transitionPublicPreviewShare(
        shareId,
        becameActive ? ['active'] : ['creating'],
        'failed',
        { failure: safeFailure(error) },
      );
      throw error;
    } finally {
      this.creations.delete(shareId);
      finishCreation();
    }
  }

  async withProjectMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    return this.withLifecycleLocks([`project:${projectId}`], async () => {
      await this.stopProject(projectId);
      return mutation();
    });
  }

  async withDevServerMutation<T>(devServerId: string, mutation: () => Promise<T>): Promise<T> {
    const release = await this.beginDevServerMutation(devServerId);
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  async beginDevServerMutation(devServerId: string): Promise<() => void> {
    const devServer = await this.options.store.getDevServer(devServerId);
    if (!devServer) return () => undefined;
    const release = await this.acquireLifecycleLocks([
      `project:${devServer.projectId}`,
      `dev-server:${devServerId}`,
    ]);
    try {
      await this.stopDevServer(devServerId);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async withLifecycleLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLifecycleLocks(keys);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquireLifecycleLocks(keys: string[]): Promise<() => void> {
    const ordered = [...new Set(keys)].sort();
    const predecessors = ordered.map((key) => this.lifecycleTails.get(key) ?? Promise.resolve());
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = Promise.all(predecessors).then(() => completed);
    for (const key of ordered) this.lifecycleTails.set(key, tail);
    await Promise.all(predecessors);
    return () => {
      release();
      for (const key of ordered) {
        if (this.lifecycleTails.get(key) === tail) this.lifecycleTails.delete(key);
      }
    };
  }

  async list(projectId: string): Promise<PublicPreviewShare[]> {
    return (await this.options.store.listPublicPreviewShares(projectId)).map(publicShare);
  }

  async stopProject(projectId: string): Promise<void> {
    const shares = await this.options.store.listPublicPreviewShares(projectId);
    await Promise.all(
      shares
        .filter((share) => ACTIVE_STATES.includes(share.state))
        .map((share) => this.stop(share.id)),
    );
  }

  async stopDevServer(devServerId: string): Promise<void> {
    const shares = await this.options.store.listPublicPreviewShares();
    await Promise.all(
      shares
        .filter((share) => share.devServerId === devServerId && ACTIVE_STATES.includes(share.state))
        .map((share) => this.stop(share.id)),
    );
  }

  /** Lease/revocation fail-closed path. The Uplink independently removes public
   * edges; locally, stop every connector immediately even when the control socket
   * is already gone. */
  async disableAll(reason: string): Promise<void> {
    const shares = await this.options.store.listPublicPreviewShares();
    const failures = await Promise.allSettled(
      shares
        .filter((share) => ACTIVE_STATES.includes(share.state))
        .map(async (share) => {
          const claimed = await this.options.store.transitionPublicPreviewShare(
            share.id,
            ['creating', 'active'],
            'revoking',
            { failure: reason },
          );
          const current = claimed ?? (await this.options.store.getPublicPreviewShare(share.id));
          if (!current || current.state !== 'revoking') return;
          await removeContainer(
            this.options.docker,
            current.connectorContainerId ?? current.connectorContainerName,
          );
          await this.options.edge.remove(current.id);
          await this.options.store.transitionPublicPreviewShare(
            current.id,
            ['revoking'],
            'revoked',
            {
              connectorContainerId: null,
              revokedAt: this.now(),
              failure: current.failure,
            },
          );
        }),
    );
    const rejected: unknown[] = [];
    for (const result of failures) {
      if (result.status === 'rejected') rejected.push(result.reason as unknown);
    }
    if (rejected.length > 0) {
      throw new AggregateError(rejected, 'one or more disabled public previews need cleanup retry');
    }
  }

  async stop(id: string, terminal: 'revoked' | 'expired' = 'revoked'): Promise<boolean> {
    const record = await this.options.store.getPublicPreviewShare(id);
    if (!record) return false;
    const claimed = await this.options.store.transitionPublicPreviewShare(
      id,
      ['creating', 'active'],
      'revoking',
    );
    const current = claimed ?? (await this.options.store.getPublicPreviewShare(id));
    if (!current || current.state === 'revoked' || current.state === 'expired') return true;
    if (current.state !== 'revoking') return false;
    await this.creations.get(id);
    const cleanup = await Promise.allSettled([
      current.connectorContainerId
        ? removeContainer(this.options.docker, current.connectorContainerId)
        : removeContainer(this.options.docker, current.connectorContainerName),
      this.options.edge.remove(id),
    ]);
    const failures: unknown[] = [];
    for (const result of cleanup) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'public preview revocation did not complete');
    }
    const resolvedTerminal =
      current.expiresAt.getTime() <= this.now().getTime() ? 'expired' : terminal;
    await this.options.store.transitionPublicPreviewShare(id, ['revoking'], resolvedTerminal, {
      connectorContainerId: null,
      revokedAt: this.now(),
    });
    return true;
  }

  /** The Uplink has authoritatively expired and removed the public edge. Only
   * local connector cleanup remains; do not send a redundant control request. */
  async finishExpiredByUplink(id: string): Promise<void> {
    const record = await this.options.store.getPublicPreviewShare(id);
    if (!record || !ACTIVE_STATES.includes(record.state)) return;
    const claimed = await this.options.store.transitionPublicPreviewShare(
      id,
      ['creating', 'active'],
      'revoking',
    );
    const current = claimed ?? (await this.options.store.getPublicPreviewShare(id));
    if (!current || current.state !== 'revoking') return;
    await this.creations.get(id);
    await removeContainer(
      this.options.docker,
      current.connectorContainerId ?? current.connectorContainerName,
    );
    await this.options.store.transitionPublicPreviewShare(id, ['revoking'], 'expired', {
      connectorContainerId: null,
      revokedAt: this.now(),
    });
  }

  /** Startup/periodic convergence: TTL, missing or replaced sandboxes, and
   * interrupted creating/revoking transactions all fail closed. */
  async reconcile(): Promise<void> {
    const shares = await this.options.store.listPublicPreviewShares();
    const failures: unknown[] = [];
    for (const share of shares) {
      if (!ACTIVE_STATES.includes(share.state)) continue;
      try {
        if (share.expiresAt.getTime() <= this.now().getTime()) {
          await this.stop(share.id, 'expired');
          continue;
        }
        if (share.state !== 'active') {
          if (
            share.state === 'revoking' ||
            this.now().getTime() - share.updatedAt.getTime() >= CREATING_LEASE_MS
          ) {
            await this.stop(share.id);
          }
          continue;
        }
        const project = await this.options.store.getProject(share.projectId);
        const devServer = share.devServerId
          ? await this.options.store.getDevServer(share.devServerId)
          : undefined;
        let matches = false;
        try {
          if (
            project?.state === 'active' &&
            (share.targetKind === 'static-folder' ||
              (devServer?.projectId === project.id &&
                devServer.containerPort === String(share.targetPort))) &&
            share.connectorContainerId !== null &&
            (share.targetKind === 'static-folder' ||
              (devServer !== undefined &&
                (await this.options.isDevServerRunning({ project, devServer }))))
          ) {
            const [sandbox, connector] = await Promise.all([
              this.options.docker.inspectContainer(project.containerName),
              this.options.docker.inspectContainer(share.connectorContainerId),
            ]);
            matches =
              sandbox.running && containerGenerationOf(sandbox) === share.containerGeneration;
            matches = matches && connector.running;
          }
        } catch {
          matches = false;
        }
        if (!matches) await this.stop(share.id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more public previews did not reconcile');
    }
  }

  private async createConnector(
    share: PublicPreviewShareRecord,
    targetContainerName: string,
    connectorImage: string,
    staticMount?: NonNullable<import('./docker.js').ContainerSpec['volumeMounts']>[number],
  ): Promise<string> {
    const spec = {
      image: connectorImage,
      name: share.connectorContainerName,
      labels: {
        [COMPONENT_LABEL]: 'public-preview-connector',
        [SHARE_LABEL]: share.id,
        [PROJECT_LABEL]: share.projectId,
        [GENERATION_LABEL]: share.containerGeneration,
        ...(share.devServerId ? { [DEV_SERVER_LABEL]: share.devServerId } : {}),
      },
      env: [
        `VERITY_PREVIEW_EDGE_URL=${share.edgeUrl}`,
        `VERITY_PREVIEW_CONNECTOR_TOKEN=${share.connectorToken}`,
        ...(share.targetKind === 'static-folder'
          ? [
              'VERITY_PREVIEW_STATIC_ROOT=/preview-workspace',
              `VERITY_PREVIEW_STATIC_PATH=${share.staticPath}`,
            ]
          : [`VERITY_PREVIEW_TARGET_ORIGIN=http://${targetContainerName}:${share.targetPort}`]),
      ],
      ...(staticMount ? { volumeMounts: [staticMount] } : {}),
      network: projectNetworkName(share.projectId),
      restartPolicy: 'on-failure' as const,
      readOnlyRootfs: true,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777' },
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 64,
      memoryBytes: 128 * 1024 * 1024,
      nanoCpus: 500_000_000,
    };
    let created;
    try {
      created = await this.options.docker.createContainer(spec);
    } catch (error) {
      if (!(error instanceof DockerError && error.kind === 'image_not_found')) throw error;
      if (!this.options.docker.pullImage) throw error;
      await this.options.docker.pullImage(connectorImage);
      created = await this.options.docker.createContainer(spec);
    }
    try {
      await this.options.docker.startContainer(created.id);
      await this.waitConnectorReady(created.id);
      return created.id;
    } catch (error) {
      await removeContainer(this.options.docker, created.id);
      throw error;
    }
  }

  private assertEdgeAvailable(): void {
    if (this.options.edge.isAvailable?.() === false) {
      throw new PreviewShareConflictError('public preview authority was lost during creation');
    }
  }

  private async resolveConnectorImage(): Promise<string> {
    if (this.connectorImage) return this.connectorImage;
    const image = await this.options.resolveConnectorImage();
    if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image)) {
      throw new PreviewShareConflictError('preview connector image is temporarily unavailable');
    }
    this.connectorImage = image;
    return image;
  }

  private async waitConnectorReady(containerId: string): Promise<void> {
    if (!this.options.docker.containerLogs) {
      throw new Error('preview connector readiness logs are unavailable');
    }
    const timeout = this.options.connectorReadyTimeoutMs ?? CONNECTOR_READY_TIMEOUT_MS;
    const poll = this.options.connectorReadyPollMs ?? CONNECTOR_READY_POLL_MS;
    const wait =
      this.options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const attempts = Math.max(1, Math.ceil(timeout / poll));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await this.options.docker.inspectContainer(containerId);
      if (!state.running) throw new Error('preview connector exited before becoming ready');
      const logs = await this.options.docker.containerLogs(containerId, 100);
      if (logs.split(/\r?\n/).includes(CONNECTOR_READY_MARKER)) return;
      if (attempt + 1 < attempts) await wait(poll);
    }
    throw new Error('preview connector readiness timed out');
  }

  private staticMount(project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>) {
    const { dataVolume, dataVolumeRoot, hostCloneRoot } = this.options;
    if (!dataVolume || !dataVolumeRoot || !hostCloneRoot) {
      throw new PreviewShareConflictError('static preview storage is not configured');
    }
    const clone = projectClonePath(hostCloneRoot, project);
    const subpath = relative(dataVolumeRoot, clone).split('\\').join('/');
    if (
      !subpath ||
      subpath === '.' ||
      posix.isAbsolute(subpath) ||
      subpath === '..' ||
      subpath.startsWith('../')
    )
      throw new PreviewShareConflictError('project is outside Verity storage');
    return { volume: dataVolume, target: '/preview-workspace', subpath, readOnly: true } as const;
  }

  private async validateStaticDirectory(
    project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>,
    staticPath: string,
  ): Promise<void> {
    const hostCloneRoot = this.options.hostCloneRoot;
    if (!hostCloneRoot) {
      throw new PreviewShareConflictError('static preview storage is not configured');
    }
    try {
      const clone = await realpath(projectClonePath(hostCloneRoot, project));
      const requested = resolve(clone, staticPath);
      let componentPath = clone;
      let entry = await lstat(clone);
      for (const component of staticPath.split('/')) {
        componentPath = join(componentPath, component);
        entry = await lstat(componentPath);
        if (entry.isSymbolicLink()) throw new Error('static path contains a symlink');
      }
      const canonical = await realpath(requested);
      const within = relative(clone, canonical).split('\\').join('/');
      if (
        !within ||
        within === '..' ||
        within.startsWith('../') ||
        posix.isAbsolute(within) ||
        entry.isSymbolicLink() ||
        !entry.isDirectory()
      ) {
        throw new Error('unsafe static directory');
      }
    } catch (error) {
      throw new PreviewShareConflictError(
        'static publish directory does not exist or is not a safe directory',
        { cause: error },
      );
    }
  }
}

function normalizedStaticPath(value: string): string {
  const normalized = posix.normalize(value.trim().replaceAll('\\', '/')).replace(/^\.\//, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').some((part) => part.startsWith('.'))
  ) {
    throw new PreviewShareInputError(
      'static folder must be an explicit project-relative publish directory without hidden paths',
    );
  }
  return normalized;
}

/** Upgrade path for an installation that shared previews through the direct
 * Kubernetes edge before it was removed (ADR 0012 D1). Without a configured
 * edge no `PreviewShareManager` exists, so nothing reconciles: connector
 * containers keep running against a sandbox forever and the share records stay
 * in a non-terminal state the API can no longer revoke. This sweep runs once at
 * startup in exactly that case and closes both out locally.
 *
 * It deliberately does not touch the edge. The installation no longer holds
 * cluster credentials, so it could not delete those objects even if they
 * existed; they carry `app.kubernetes.io/name=verity-preview-edge` and are
 * removed cluster-side (see `docs/handoffs/PUBLIC_PREVIEW_UPLINK_HANDOFF.md`).
 * Cutting the connector is what actually ends public access: the edge only
 * serves a share while the connector dials in. */
export async function sweepOrphanedPreviewShares(options: {
  store: EventStore;
  docker: DockerClient;
  now?: () => Date;
}): Promise<number> {
  const now = options.now ?? (() => new Date());
  const shares = await options.store.listPublicPreviewShares();
  const failures: unknown[] = [];
  let swept = 0;
  for (const share of shares) {
    if (!ACTIVE_STATES.includes(share.state)) continue;
    try {
      await removeContainer(
        options.docker,
        share.connectorContainerId ?? share.connectorContainerName,
      );
      await options.store.transitionPublicPreviewShare(share.id, ACTIVE_STATES, 'revoked', {
        connectorContainerId: null,
        revokedAt: now(),
      });
      swept += 1;
    } catch (error) {
      // One unreachable container must not strand the remaining records.
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'one or more orphaned public previews did not close out');
  }
  return swept;
}

export class PreviewShareInputError extends Error {}
export class PreviewShareNotFoundError extends Error {}
export class PreviewShareConflictError extends Error {}

function publicShare(record: PublicPreviewShareRecord): PublicPreviewShare {
  return {
    id: record.id,
    projectId: record.projectId,
    devServerId: record.devServerId,
    targetKind: record.targetKind ?? 'dev-server',
    staticPath: record.staticPath ?? null,
    state: record.state,
    publicOrigin: record.publicOrigin,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    failure: record.failure,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validPort(value: string): boolean {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535;
}

function devServerLifecycleKey(
  devServer: NonNullable<Awaited<ReturnType<EventStore['getDevServer']>>>,
): string {
  return JSON.stringify({
    projectId: devServer.projectId,
    command: devServer.command,
    workdir: devServer.workdir,
    containerPort: devServer.containerPort,
    previewSessionId: devServer.previewSessionId,
    autoStart: devServer.autoStart,
    updatedAt: devServer.updatedAt?.toISOString(),
  });
}

async function assertEligibleSandbox(
  sandbox: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  expectedNetwork: string,
  projectId: string,
  workspaceSubpath: string,
  options: Pick<
    PreviewShareManagerOptions,
    'dataVolume' | 'dataVolumeRoot' | 'inspectArtifact' | 'listArtifactDirectory'
  >,
): Promise<void> {
  const networks = Object.keys(sandbox.networks ?? {});
  if (networks.length !== 1 || networks[0] !== expectedNetwork) {
    throw new PreviewShareConflictError('sandbox is attached to unexpected networks');
  }
  const capAdd = [...(sandbox.capAdd ?? [])].sort();
  const allowedCapabilities = [...RUNNER_BROKER_CAPABILITIES].sort();
  if (
    sandbox.privileged !== false ||
    sandbox.deviceCount === undefined ||
    sandbox.deviceCount > 0 ||
    sandbox.capAdd === undefined ||
    (capAdd.length > 0 &&
      (capAdd.length !== allowedCapabilities.length ||
        capAdd.some((capability, index) => capability !== allowedCapabilities[index])))
  ) {
    throw new PreviewShareConflictError('sandbox security metadata is incomplete or privileged');
  }
  const containerUser = sandbox.user?.split(':', 1)[0];
  if (
    sandbox.runtime !== PROJECT_RUNSC_RUNTIME ||
    containerUser === undefined ||
    containerUser === '' ||
    containerUser === '0' ||
    containerUser === 'root' ||
    sandbox.capDrop?.includes('ALL') !== true ||
    sandbox.securityOpt?.includes('no-new-privileges:true') !== true
  ) {
    throw new PreviewShareConflictError('sandbox does not satisfy public preview hardening');
  }
  if (sandbox.mounts === undefined || sandbox.mountCount !== sandbox.mounts.length) {
    throw new PreviewShareConflictError('sandbox mount metadata is incomplete');
  }
  const allowedSensitivePathEnv = new Map([
    ['VERITY_GH_BROKER_CAPABILITY_FILE', '/run/verity/gh-token-capability'],
    ['VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE', '/run/verity/claude-egress/client.key'],
  ]);
  const nonSecretBrokerCoordinates = new Set([
    'VERITY_GH_TOKEN_URL',
    'VERITY_GH_TOKEN_DOCKER_CONTAINER',
  ]);
  if (sandbox.env === undefined) {
    throw new PreviewShareConflictError('sandbox environment metadata is incomplete');
  }
  const secretEnv = sandbox.env.some((entry) => {
    const separator = entry.indexOf('=');
    const name = (separator < 0 ? entry : entry.slice(0, separator)).toUpperCase();
    const value = separator < 0 ? '' : entry.slice(separator + 1);
    const allowedPath = allowedSensitivePathEnv.get(name);
    if (allowedPath !== undefined) return value !== allowedPath;
    if (nonSecretBrokerCoordinates.has(name)) return false;
    return (
      /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS?)(_|$)/.test(
        name,
      ) ||
      /_KEY(_FILE)?$/.test(name) ||
      /(^|_)(DATABASE|DB|POSTGRES|REDIS|MONGO)(_URL|_URI)$/.test(name)
    );
  });
  if (secretEnv) throw new PreviewShareConflictError('sandbox contains direct credentials');
  const publicSshDestinations = new Map([
    ['/home/dev/.ssh/id_ed25519.pub', '/git/id_ed25519.pub'],
    ['/home/dev/.ssh/known_hosts', '/git/known_hosts'],
    ['/home/dev/.ssh/allowed_signers', '/git/allowed_signers'],
    ['/run/verity/ssh/id_ed25519.pub', '/git/id_ed25519.pub'],
    ['/run/verity/ssh/known_hosts', '/git/known_hosts'],
    ['/run/verity/ssh/allowed_signers', '/git/allowed_signers'],
  ]);
  for (const mount of sandbox.mounts) {
    const allowedSourceSuffix =
      mount.destination === undefined ? undefined : publicSshDestinations.get(mount.destination);
    if (
      mount.readWrite === false &&
      allowedSourceSuffix !== undefined &&
      mount.source?.endsWith(allowedSourceSuffix) === true
    ) {
      continue;
    }
    if (
      mount.destination === '/work' &&
      mount.type === 'volume' &&
      mount.name === options.dataVolume &&
      mount.readWrite === true &&
      mount.subpath === workspaceSubpath
    ) {
      continue;
    }
    if (
      mount.readWrite === false &&
      mount.destination === '/opt/agent-seed' &&
      mount.source?.endsWith('/agent-seed') === true
    ) {
      continue;
    }
    if (
      mount.readWrite === false &&
      mount.destination === '/etc/profile.d/gh-token.sh' &&
      mount.source === '/dev/null'
    ) {
      continue;
    }
    if (
      mount.destination === '/run/verity-runner' &&
      mount.type === 'volume' &&
      mount.name === options.dataVolume &&
      mount.readWrite === true &&
      mount.subpath === `runners/${projectId}`
    ) {
      continue;
    }
    if (
      await knownPreviewArtifact(
        mount,
        projectId,
        sandbox.labels?.[SIGNING_BROKER_TOKEN_HASH_LABEL],
        options,
      )
    )
      continue;
    throw new PreviewShareConflictError('sandbox contains mounted credentials');
  }
}

function projectWorkspaceSubpath(
  project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>,
  options: Pick<PreviewShareManagerOptions, 'dataVolumeRoot' | 'hostCloneRoot'>,
): string {
  if (options.dataVolumeRoot === undefined || options.hostCloneRoot === undefined) {
    throw new PreviewShareConflictError('public preview storage is not configured');
  }
  const subpath = relative(options.dataVolumeRoot, projectClonePath(options.hostCloneRoot, project))
    .split('\\')
    .join('/');
  if (!subpath || subpath === '.' || posix.isAbsolute(subpath) || subpath.startsWith('../')) {
    throw new PreviewShareConflictError('project is outside Verity storage');
  }
  return subpath;
}

type SandboxMount = NonNullable<
  Awaited<ReturnType<DockerClient['inspectContainer']>>['mounts']
>[number];

async function knownPreviewArtifact(
  mount: SandboxMount,
  projectId: string,
  signingCapabilityDigest: string | undefined,
  options: Pick<
    PreviewShareManagerOptions,
    'dataVolume' | 'dataVolumeRoot' | 'inspectArtifact' | 'listArtifactDirectory'
  >,
): Promise<boolean> {
  if (mount.readWrite !== false || options.dataVolumeRoot === undefined) return false;
  const specs = [
    {
      destination: '/run/verity/gh-token-capability',
      relative: `secrets/git/gh_token_capability.${projectId}`,
      mode: 0o600,
      kind: 'file' as const,
    },
    {
      destination: '/run/verity/ssh/signing_broker_token',
      relative:
        signingCapabilityDigest === undefined
          ? undefined
          : `secrets/git/signing_broker_token.${signingCapabilityDigest}`,
      mode: 0o600,
      kind: 'file' as const,
    },
    {
      destination: '/run/verity/claude-egress/ca.crt',
      relative: `secrets/claude-egress/egress_ca.${projectId}.crt`,
      mode: 0o644,
      kind: 'file' as const,
    },
    {
      destination: '/run/verity/claude-egress/client.crt',
      relative: `secrets/claude-egress/egress_client.${projectId}.crt`,
      mode: 0o644,
      kind: 'file' as const,
    },
    {
      destination: '/run/verity/claude-egress/client.key',
      relative: `secrets/claude-egress/egress_client.${projectId}.key`,
      mode: 0o040,
      gid: 1101,
      kind: 'file' as const,
    },
    {
      destination: '/run/verity/codex/config.toml',
      relative: 'secrets/codex/config.toml',
      mode: 0o644,
      kind: 'file' as const,
      validate: validCodexGatewayConfig,
    },
    {
      destination: '/run/verity/opencode-config',
      relative: 'secrets/opencode',
      mode: 0o755,
      kind: 'directory' as const,
      child: 'opencode.json',
      childMode: 0o644,
      validate: validOpenCodeGatewayConfig,
    },
  ];
  const spec = specs.find((candidate) => candidate.destination === mount.destination);
  if (spec === undefined) return false;
  const relative = spec.relative;
  if (relative === undefined) return false;
  if (!mountMatchesProjectData(mount, relative, options.dataVolume, options.dataVolumeRoot))
    return false;
  const inspect = options.inspectArtifact ?? inspectPreviewArtifact;
  const ownerUid = RUNNER_AGENT_UID;
  const artifact = await inspect(
    join(options.dataVolumeRoot, relative),
    spec.validate !== undefined,
  ).catch(() => undefined);
  if (artifact === undefined) return false;
  if (
    artifact.kind !== spec.kind ||
    artifact.uid !== ownerUid ||
    artifact.mode !== spec.mode ||
    (spec.gid !== undefined && artifact.gid !== spec.gid)
  ) {
    return false;
  }
  if (spec.child !== undefined) {
    const directory = join(options.dataVolumeRoot, relative);
    const entries = await listArtifactDirectory(options, directory).catch(() => undefined);
    if (entries === undefined || entries.length !== 1 || entries[0] !== spec.child) return false;
    const child = await inspect(join(directory, spec.child), true).catch(() => undefined);
    return (
      child !== undefined &&
      child.kind === 'file' &&
      child.uid === ownerUid &&
      child.mode === spec.childMode &&
      child.contents !== undefined &&
      spec.validate?.(child.contents) === true
    );
  }
  return (
    spec.validate === undefined ||
    (artifact.contents !== undefined && spec.validate(artifact.contents))
  );
}

async function listArtifactDirectory(
  options: Pick<PreviewShareManagerOptions, 'listArtifactDirectory'>,
  path: string,
): Promise<string[]> {
  if (options.listArtifactDirectory !== undefined) return options.listArtifactDirectory(path);
  return readdir(path);
}

function validCodexGatewayConfig(contents: string): boolean {
  const port = /^base_url = "http:\/\/127\.0\.0\.1:(\d+)\/codex"$/mu.exec(contents)?.[1];
  if (port === undefined) return false;
  try {
    return contents.trim() === codexGatewayConfig(Number(port)).trim();
  } catch {
    return false;
  }
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validOpenCodeGatewayConfig(contents: string): boolean {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    if (!exactKeys(parsed, ['$schema', 'autoupdate', 'provider'])) return false;
    const { $schema, autoupdate, provider } = parsed as {
      $schema?: unknown;
      autoupdate?: unknown;
      provider?: unknown;
    };
    if ($schema !== 'https://opencode.ai/config.json' || autoupdate !== false) return false;
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return false;
    if (!exactKeys(provider, ['verity'])) return false;
    const verity = (provider as { verity?: unknown }).verity;
    if (typeof verity !== 'object' || verity === null || Array.isArray(verity)) return false;
    if (!exactKeys(verity, ['npm', 'name', 'options', 'models'])) return false;
    const {
      npm,
      name,
      options: gateway,
      models,
    } = verity as {
      npm?: unknown;
      name?: unknown;
      options?: unknown;
      models?: unknown;
    };
    if (npm !== '@ai-sdk/openai-compatible' || name !== 'OpenAI-compatible') return false;
    if (typeof gateway !== 'object' || gateway === null || Array.isArray(gateway)) return false;
    if (!exactKeys(gateway, ['baseURL', 'apiKey'])) return false;
    const { baseURL, apiKey } = gateway as { baseURL?: unknown; apiKey?: unknown };
    if (
      typeof baseURL !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+\/opencode$/u.test(baseURL) ||
      apiKey !== 'verity-opencode-gateway-placeholder-v1'
    )
      return false;
    if (typeof models !== 'object' || models === null || Array.isArray(models)) return false;
    const entries = Object.entries(models as Record<string, unknown>);
    return (
      entries.length > 0 &&
      entries.every(([model, value]) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        return exactKeys(value, ['name']) && (value as { name?: unknown }).name === model;
      })
    );
  } catch {
    return false;
  }
}

function mountMatchesProjectData(
  mount: SandboxMount,
  relative: string,
  dataVolume: string | undefined,
  dataVolumeRoot: string,
): boolean {
  if (mount.type === 'volume') {
    return mount.name === dataVolume && mount.subpath === relative;
  }
  return mount.type === 'bind' && mount.source === join(dataVolumeRoot, relative);
}

async function inspectPreviewArtifact(
  path: string,
  readContents = false,
): Promise<{
  uid: number;
  gid: number;
  mode: number;
  kind: 'file' | 'directory';
  contents?: string;
}> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new PreviewShareConflictError('sandbox artifact is not a regular file or directory');
  }
  return {
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode & 0o777,
    kind: stats.isDirectory() ? 'directory' : 'file',
    ...(stats.isFile() && readContents ? { contents: await readFile(path, 'utf8') } : {}),
  };
}

function normalizedHttps(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('preview public origin must be an HTTPS origin');
  }
  return url.origin;
}

function normalizedEdgeUrl(value: string, publicOrigin: string): string {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.origin.replace(/^wss:/, 'https:') !== publicOrigin) {
    throw new Error('preview edge URL must be WSS on the public preview origin');
  }
  return url.href;
}

function validShareId(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error('Uplink returned an invalid share id');
  }
  return value;
}

function validSecret(value: string, name: string): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096) {
    throw new Error(`Uplink returned an invalid ${name}`);
  }
  return value;
}

async function hashPin(pin: string): Promise<string> {
  const { scrypt } = await import('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(pin, salt, 32, (error, key) => (error ? reject(error) : resolve(key))),
  );
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function removeContainer(docker: DockerClient, id: string): Promise<void> {
  try {
    await docker.removeContainer(id);
  } catch (error) {
    if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'preview share setup failed';
  return message.slice(0, 500);
}
