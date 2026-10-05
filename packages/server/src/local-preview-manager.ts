import { randomBytes } from 'node:crypto';
import { PreviewEdge, hashPreviewSecret } from '@verity/preview-tunnel';
import type { EventStore } from '@verity/store';
import { DockerError } from './docker.js';
import { projectNetworkName } from './provisioner.js';
import { containerGenerationOf } from './project-relay-migration.js';
import { localPreviewPorts } from './local-preview-ports.js';
import {
  PreviewShareManager,
  PreviewShareConflictError,
  type PreviewShareManagerOptions,
} from './preview-share-manager.js';

export interface LocalPreviewShare {
  id: string;
  url: string;
  projectId: string;
  sessionId: string;
  targetPort: number | null;
  staticPath: string | null;
  expiresAt: Date;
}
interface ActiveShare {
  share: LocalPreviewShare;
  port: number;
  edge: PreviewEdge;
  connectorId?: string;
  generation: string;
  missingSince?: number;
  edgeClosed?: boolean;
  edgeStarted?: boolean;
  ready?: boolean;
  provisioning?: boolean;
  preparedPort?: number;
}
export interface LocalPreviewManagerOptions extends Omit<PreviewShareManagerOptions, 'edge'> {
  publicHost: string;
  /** Actual Server container DNS identity; the managed gateway is a different process. */
  connectorHost: string;
  resolveConnectorHost?: () => Promise<string>;
  connectorNetwork: string;
  portRange?: string;
  prepareTargetPort?: (
    project: NonNullable<Awaited<ReturnType<EventStore['getProject']>>>,
    port: number,
  ) => Promise<number>;
}

/** Local edges are process-owned. Restarting Server closes their sockets; startup
 * removes the labelled orphan connectors instead of restoring stale URLs. */
export class LocalPreviewManager {
  private readonly active = new Map<string, ActiveShare>();
  private readonly reserved = new Set<number>();
  private readonly targets: PreviewShareManager;
  private readonly ports: number[];
  private readonly blockedProjects = new Set<string>();
  private readonly creating = new Set<Promise<unknown>>();
  private closing = false;
  private readonly blockedSessions = new Set<string>();
  private readonly pendingTargets = new Map<string, Promise<LocalPreviewShare>>();
  private bufferedRequests = 0;
  private readonly requestBudget = {
    acquire: () => {
      if (this.bufferedRequests >= 2) return false;
      this.bufferedRequests++;
      return true;
    },
    release: () => {
      this.bufferedRequests--;
    },
  };

  constructor(private readonly options: LocalPreviewManagerOptions) {
    this.ports = localPreviewPorts(options.portRange);
    this.targets = new PreviewShareManager({
      ...options,
      edge: {
        create: () => Promise.reject(new Error('no public edge')),
        remove: async () => {},
      },
    });
  }
  listStaticEntries(projectId: string, path: string, sessionId: string) {
    return this.targets.listStaticEntries(projectId, path, sessionId);
  }
  list(sessionId: string): LocalPreviewShare[] {
    return [...this.active.values()]
      .filter((v) => v.ready && v.share.sessionId === sessionId)
      .map((v) => v.share);
  }
  listProject(projectId: string): LocalPreviewShare[] {
    return [...this.active.values()]
      .filter((v) => v.ready && v.share.projectId === projectId)
      .map((v) => v.share);
  }
  ownsConnector(id: string, shareId?: string): boolean {
    if (shareId && this.active.has(shareId)) return true;
    return [...this.active.values()].some((state) => state.connectorId === id);
  }
  hasProjectShares(projectId: string): boolean {
    return [...this.active.values()].some((v) => v.share.projectId === projectId);
  }
  async create(
    sessionId: string,
    input: {
      targetPort?: number | undefined;
      staticPath?: string | undefined;
      ttlSeconds?: number | undefined;
    },
  ): Promise<LocalPreviewShare> {
    const key = JSON.stringify([sessionId, input.targetPort ?? null, input.staticPath ?? null]);
    const pending = this.pendingTargets.get(key);
    if (pending) return pending;
    const promise = this.createInner(sessionId, input);
    this.pendingTargets.set(key, promise);
    this.creating.add(promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(promise);
      this.pendingTargets.delete(key);
    }
  }
  private async createInner(
    sessionId: string,
    input: {
      targetPort?: number | undefined;
      staticPath?: string | undefined;
      ttlSeconds?: number | undefined;
    },
  ): Promise<LocalPreviewShare> {
    if (this.closing || this.blockedSessions.has(sessionId))
      throw new PreviewShareConflictError('local previews are stopping');
    const ttl = input.ttlSeconds ?? 86400;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 86400)
      throw new PreviewShareConflictError('invalid local preview lifetime');
    const target = await this.targets.prepareLocalTarget(sessionId, input);
    if (
      this.closing ||
      this.blockedSessions.has(sessionId) ||
      this.blockedProjects.has(target.project.id)
    )
      throw new PreviewShareConflictError('project is changing');
    const existing = this.list(sessionId).find(
      (s) =>
        s.targetPort === (input.targetPort ?? null) && s.staticPath === (input.staticPath ?? null),
    );
    if (existing && existing.expiresAt.getTime() > Date.now()) return existing;
    if (existing) await this.stop(existing.id);
    const port = this.ports.find((p) => !this.reserved.has(p));
    if (port === undefined)
      throw new PreviewShareConflictError(
        'local preview ports are full; stop a preview or expand VERITY_LOCAL_PREVIEW_PORT_RANGE',
      );
    this.reserved.add(port);
    const id = `local-${randomBytes(16).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    const url = new URL(`http://${this.options.publicHost}:${port}`).origin;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const edge = new PreviewEdge({
      shareId: id,
      accessMode: 'local-open',
      pinHash: `scrypt:${'a'.repeat(32)}:${'a'.repeat(64)}`,
      connectorTokenHash: hashPreviewSecret(secret),
      sessionSecretHash: hashPreviewSecret(secret),
      publicOrigin: url,
      expiresAt: expiresAt.toISOString(),
      maxBodyBytes: 100 * 1024 * 1024,
      maxConcurrentRequests: 8,
      maxConcurrentStreams: 4,
      requestBudget: this.requestBudget,
    });
    const state: ActiveShare = {
      share: {
        id,
        url,
        projectId: target.project.id,
        sessionId,
        targetPort: input.targetPort ?? null,
        staticPath: input.staticPath ?? null,
        expiresAt,
      },
      port,
      edge,
      generation: target.generation,
      provisioning: true,
    };
    this.active.set(id, state);
    try {
      await edge.listen(port, '0.0.0.0');
      state.edgeStarted = true;
      const image = await this.options.resolveConnectorImage();
      if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image))
        throw new PreviewShareConflictError('preview connector image is unavailable');
      const targetPort =
        input.targetPort === undefined
          ? undefined
          : ((await this.options.prepareTargetPort?.(target.project, input.targetPort)) ??
            input.targetPort);
      if (targetPort !== undefined) state.preparedPort = targetPort;
      const connectorHost =
        (await this.options.resolveConnectorHost?.()) ?? this.options.connectorHost;
      const spec = {
        image,
        name: `verity-preview-${id}`,
        user: '1000:1000',
        labels: {
          'verity.component': 'local-preview-connector',
          'verity.project-id': target.project.id,
          'verity.local-preview-share-id': id,
          'verity.local-preview-server': this.options.connectorHost,
        },
        env: [
          `VERITY_PREVIEW_EDGE_URL=ws://${connectorHost}:${port}/__verity/connector`,
          `VERITY_PREVIEW_CONNECTOR_TOKEN=${secret}`,
          'VERITY_PREVIEW_ACCESS_MODE=local-open',
          `VERITY_PREVIEW_MAX_BODY_BYTES=${100 * 1024 * 1024}`,
          ...(target.staticMount
            ? ['VERITY_PREVIEW_STATIC_ROOT=/preview-workspace', 'VERITY_PREVIEW_STATIC_PATH=public']
            : [
                `VERITY_PREVIEW_TARGET_ORIGIN=http://${target.project.containerName}:${targetPort}`,
              ]),
        ],
        ...(target.staticMount ? { volumeMounts: [target.staticMount] } : {}),
        network: projectNetworkName(target.project.id),
        additionalNetworks: [this.options.connectorNetwork],
        readOnlyRootfs: true,
        tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777' },
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges:true'],
        pidsLimit: 64,
        memoryBytes: 384 * 1024 * 1024,
        nanoCpus: 500_000_000,
      };
      let created;
      try {
        created = await this.options.docker.createContainer(spec);
      } catch (error) {
        if (
          !(error instanceof DockerError && error.kind === 'image_not_found') ||
          !this.options.docker.pullImage
        )
          throw error;
        await this.options.docker.pullImage(image);
        created = await this.options.docker.createContainer(spec);
      }
      state.connectorId = created.id;
      await this.options.docker.startContainer(created.id);
      if (!this.options.docker.containerLogs)
        throw new Error('connector readiness logs unavailable');
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!(await this.options.docker.inspectContainer(created.id)).running)
          throw new Error('local connector exited');
        if (
          (await this.options.docker.containerLogs(created.id, 50)).includes(
            'preview connector established',
          )
        ) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error('local connector did not become ready');
      const current = await this.targets.prepareLocalTarget(sessionId, input);
      if (
        current.generation !== state.generation ||
        this.blockedProjects.has(target.project.id) ||
        this.closing ||
        this.blockedSessions.has(sessionId)
      )
        throw new PreviewShareConflictError('project changed during preview creation');
      state.provisioning = false;
      state.ready = true;
      return state.share;
    } catch (error) {
      state.provisioning = false;
      await this.stop(id);
      throw error;
    }
  }
  async stop(id: string): Promise<boolean> {
    const state = this.active.get(id);
    if (!state) return false;
    // Keep the lease until both resources are closed; a failed Docker removal is retried.
    if (!state.edgeClosed && state.edgeStarted) {
      await state.edge.close();
      state.edgeClosed = true;
    }
    if (state.connectorId) {
      try {
        await this.options.docker.removeContainer(state.connectorId);
      } catch (error) {
        if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
      }
    }
    this.active.delete(id);
    this.reserved.delete(state.port);
    return true;
  }
  async stopProject(projectId: string): Promise<void> {
    for (const state of this.active.values())
      if (state.share.projectId === projectId) await this.stop(state.share.id);
  }
  async stopSession(sessionId: string): Promise<void> {
    this.blockedSessions.add(sessionId);
    try {
      await Promise.allSettled([...this.creating]);
      for (const share of this.list(sessionId)) await this.stop(share.id);
    } finally {
      this.blockedSessions.delete(sessionId);
    }
  }
  async withProjectMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    const release = await this.beginSessionMove(projectId);
    try {
      await this.stopProject(projectId);
      return await mutation();
    } finally {
      release();
    }
  }
  async beginSessionMove(projectId: string): Promise<() => void> {
    if (this.blockedProjects.has(projectId))
      throw new PreviewShareConflictError('project is already changing');
    this.blockedProjects.add(projectId);
    try {
      await Promise.allSettled([...this.creating]);
    } catch (error) {
      this.blockedProjects.delete(projectId);
      throw error;
    }
    return () => {
      this.blockedProjects.delete(projectId);
    };
  }
  async reconcile(): Promise<void> {
    for (const state of this.active.values()) {
      if (state.provisioning) continue;
      if (!state.ready) {
        await this.stop(state.share.id);
        continue;
      }
      if (state.share.expiresAt.getTime() <= Date.now()) {
        await this.stop(state.share.id);
        continue;
      }
      const project = await this.options.store.getProject(state.share.projectId);
      const session = await this.options.store.getSession(state.share.sessionId);
      if (!project || project.state !== 'active' || session?.projectId !== project.id) {
        await this.stop(state.share.id);
        continue;
      }
      try {
        const sandbox = await this.options.docker.inspectContainer(project.containerName);
        if (
          !sandbox.running ||
          containerGenerationOf(sandbox) !== state.generation ||
          !state.connectorId ||
          !(await this.options.docker.inspectContainer(state.connectorId)).running
        ) {
          await this.stop(state.share.id);
          continue;
        }
        await this.targets.prepareLocalTarget(state.share.sessionId, {
          ...(state.share.targetPort === null ? {} : { targetPort: state.share.targetPort }),
          ...(state.share.staticPath === null ? {} : { staticPath: state.share.staticPath }),
        });
        if (state.share.targetPort !== null) {
          const preparedPort =
            (await this.options.prepareTargetPort?.(project, state.share.targetPort)) ??
            state.share.targetPort;
          if (preparedPort !== state.preparedPort) {
            await this.stop(state.share.id);
            continue;
          }
        }
        delete state.missingSince;
      } catch {
        if (state.share.targetPort !== null) {
          const processes = await this.options
            .listListeningProcesses?.(project)
            .catch(() => undefined);
          if (processes?.some((process) => process.port === state.share.targetPort)) {
            await this.stop(state.share.id);
            continue;
          }
        }
        state.missingSince ??= Date.now();
        if (Date.now() - state.missingSince >= 90_000) await this.stop(state.share.id);
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.creating]);
    for (const id of this.active.keys()) await this.stop(id);
  }
}
