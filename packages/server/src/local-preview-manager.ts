import { randomBytes } from 'node:crypto';
import { PreviewEdge, hashPreviewSecret } from '@verity/preview-tunnel';
import type { EventStore, LocalPreviewShareRecord } from '@verity/store';
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
  /** Network ports reserved for managed dev servers; ad hoc shares skip them. */
  reservedNetworkPorts?: () => ReadonlySet<number>;
}

/** Durable share intent survives resource shutdown and is restored on activation. */
export class LocalPreviewManager {
  private readonly active = new Map<string, ActiveShare>();
  private readonly reserved = new Set<number>();
  private readonly durableIds = new Set<string>();
  private readonly durable = new Map<string, LocalPreviewShareRecord>();
  private readonly restoring = new Map<string, Promise<LocalPreviewShare>>();
  private readonly stopping = new Set<string>();
  // Share IDs are never reused: a stale recovery snapshot must not resurrect a stopped share.
  private readonly stopped = new Set<string>();
  private readonly targets: PreviewShareManager;
  private readonly ports: number[];
  private readonly blockedProjects = new Set<string>();
  private readonly creating = new Set<Promise<unknown>>();
  private closing = false;
  private recovering?: Promise<void>;
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
    return this.visibleShares().filter((share) => share.sessionId === sessionId);
  }
  listProject(projectId: string): LocalPreviewShare[] {
    return this.visibleShares().filter((share) => share.projectId === projectId);
  }
  private publicShare(saved: LocalPreviewShareRecord): LocalPreviewShare {
    return {
      id: saved.id,
      url: saved.url,
      projectId: saved.projectId,
      sessionId: saved.sessionId,
      targetPort: saved.targetPort,
      staticPath: saved.staticPath,
      expiresAt: saved.expiresAt,
    };
  }
  private visibleShares(): LocalPreviewShare[] {
    const shares = new Map<string, LocalPreviewShare>();
    for (const saved of this.durable.values())
      if (saved.state === 'active' && !this.stopping.has(saved.id) && !this.stopped.has(saved.id))
        shares.set(saved.id, this.publicShare(saved));
    for (const state of this.active.values())
      if (state.ready && !this.stopping.has(state.share.id) && !this.stopped.has(state.share.id))
        shares.set(state.share.id, state.share);
    return [...shares.values()];
  }
  /** Network ports held by shares right now, with the share that holds each. */
  heldPorts(): Map<number, LocalPreviewShare> {
    return new Map([
      ...[...this.durable.values()].map((saved): [number, LocalPreviewShare] => [
        saved.networkPort,
        this.publicShare(saved),
      ]),
      ...[...this.active.values()].map((state): [number, LocalPreviewShare] => [
        state.port,
        state.share,
      ]),
    ]);
  }
  portOf(shareId: string): number | undefined {
    return this.active.get(shareId)?.port ?? this.durable.get(shareId)?.networkPort;
  }
  ownsConnector(id: string, shareId?: string): boolean {
    if (shareId && (this.active.has(shareId) || this.durableIds.has(shareId))) return true;
    return [...this.active.values()].some((state) => state.connectorId === id);
  }
  hasProjectShares(projectId: string): boolean {
    return this.visibleShares().some((share) => share.projectId === projectId);
  }
  async create(
    sessionId: string,
    input: {
      targetPort?: number | undefined;
      staticPath?: string | undefined;
      ttlSeconds?: number | undefined;
      /** The managed dev server's reserved network port. */
      networkPort?: number | undefined;
      managedInstanceId?: string | undefined;
    },
  ): Promise<LocalPreviewShare> {
    await this.hydrate();
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
      networkPort?: number | undefined;
      managedInstanceId?: string | undefined;
    },
    saved?: LocalPreviewShareRecord,
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
    const existing = this.visibleShares().find(
      (s) =>
        s.id !== saved?.id &&
        s.sessionId === sessionId &&
        s.targetPort === (input.targetPort ?? null) &&
        s.staticPath === (input.staticPath ?? null),
    );
    const existingPort = existing ? this.portOf(existing.id) : undefined;
    if (
      existing &&
      existing.expiresAt.getTime() > Date.now() &&
      (input.networkPort === undefined || existingPort === input.networkPort)
    )
      return existing;
    if (existing) await this.stopInner(existing.id);
    const managed = this.options.reservedNetworkPorts?.() ?? new Set<number>();
    const port =
      input.networkPort !== undefined
        ? this.reserved.has(input.networkPort) || !this.ports.includes(input.networkPort)
          ? undefined
          : input.networkPort
        : this.ports.find((p) => !this.reserved.has(p) && !managed.has(p));
    if (port === undefined && input.networkPort !== undefined)
      throw new PreviewShareConflictError('the reserved network port is in use');
    if (port === undefined)
      throw new PreviewShareConflictError(
        'local preview ports are full; stop a preview or expand VERITY_LOCAL_PREVIEW_PORT_RANGE',
      );
    this.reserved.add(port);
    const id = saved?.id ?? `local-${randomBytes(16).toString('hex')}`;
    const secret = saved?.connectorSecret ?? randomBytes(32).toString('base64url');
    const url = saved?.url ?? new URL(`http://${this.options.publicHost}:${port}`).origin;
    const expiresAt = saved?.expiresAt ?? new Date(Date.now() + ttl * 1000);
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
      if (!saved)
        await this.options.store.createLocalPreviewShare({
          ...state.share,
          managedInstanceId:
            input.managedInstanceId ??
            (await this.options.store.managedDevServers?.listInstances({ sessionId }))?.find(
              (instance) =>
                instance.sandboxPort === input.targetPort && instance.networkPort === port,
            )?.id ??
            null,
          networkPort: port,
          connectorSecret: secret,
        });
      const record = (await this.options.store.listLocalPreviewShares()).find(
        (entry) => entry.id === id,
      );
      if (record) {
        this.durable.set(id, record);
        this.durableIds.add(id);
      }
      // A process handoff may leave the old connector behind; replace it with the
      // same credentials after claiming its durable identity.
      if (saved) {
        try {
          await this.options.docker.removeContainer(`verity-preview-${id}`);
        } catch (error) {
          if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
        }
      }
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
        this.stopping.has(id) ||
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
      if (saved) await this.release(id);
      else await this.stopInner(id);
      throw error;
    }
  }
  async stop(id: string): Promise<boolean> {
    this.stopped.add(id);
    this.stopping.add(id);
    try {
      await this.options.store.revokeLocalPreviewShare(id);
      await this.restoring.get(id)?.catch(() => {});
      if (this.active.get(id)?.provisioning)
        await Promise.allSettled([...this.pendingTargets.values()]);
      return await this.stopInner(id);
    } finally {
      this.stopping.delete(id);
    }
  }
  private async stopInner(id: string): Promise<boolean> {
    this.stopped.add(id);
    const saved = (await this.options.store.listLocalPreviewShares()).find(
      (share) => share.id === id,
    );
    await this.options.store.revokeLocalPreviewShare(id);
    const removed = await this.release(id);
    if (!removed) {
      try {
        await this.options.docker.removeContainer(`verity-preview-${id}`);
      } catch (error) {
        if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
      }
    }
    this.durableIds.delete(id);
    this.durable.delete(id);
    if (saved) this.reserved.delete(saved.networkPort);
    await this.options.store.deleteLocalPreviewShare(id);
    return removed || saved !== undefined;
  }
  private async release(id: string): Promise<boolean> {
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
    for (const share of await this.options.store.listLocalPreviewShares())
      if (share.projectId === projectId) await this.stop(share.id);
  }
  async stopSession(sessionId: string): Promise<void> {
    this.blockedSessions.add(sessionId);
    try {
      await Promise.allSettled([...this.creating]);
      for (const share of await this.options.store.listLocalPreviewShares())
        if (share.sessionId === sessionId) await this.stop(share.id);
    } finally {
      this.blockedSessions.delete(sessionId);
    }
  }
  async withProjectMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    const release = await this.beginSessionMove(projectId);
    try {
      for (const share of this.listProject(projectId)) {
        const port = this.portOf(share.id);
        await this.release(share.id);
        if (port !== undefined) this.reserved.add(port);
      }
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
  restore(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.recovering) return this.recovering;
    const work = this.restoreInner();
    this.recovering = work;
    this.creating.add(work);
    void work
      .finally(() => {
        this.creating.delete(work);
        delete this.recovering;
      })
      .catch(() => {});
    return work;
  }
  private async hydrate(): Promise<LocalPreviewShareRecord[]> {
    const records = await this.options.store.listLocalPreviewShares();
    const ids = new Set(records.map((record) => record.id));
    for (const [id, saved] of this.durable) {
      if (!ids.has(id)) {
        this.durable.delete(id);
        this.durableIds.delete(id);
        if (!this.active.has(id)) this.reserved.delete(saved.networkPort);
      }
    }
    for (const saved of records) {
      if (this.stopped.has(saved.id)) continue;
      this.durableIds.add(saved.id);
      this.durable.set(saved.id, saved);
      if (!this.active.has(saved.id)) this.reserved.add(saved.networkPort);
    }
    return records;
  }
  private async restoreInner(): Promise<void> {
    const records = await this.hydrate();
    for (const saved of records) {
      if (this.closing) return;
      if (this.stopped.has(saved.id)) {
        await this.stopInner(saved.id);
        continue;
      }
      if (saved.state === 'revoking' || saved.expiresAt.getTime() <= Date.now()) {
        await this.stop(saved.id);
        continue;
      }
      if (this.active.has(saved.id)) continue;
      const project = await this.options.store.getProject(saved.projectId);
      const session = await this.options.store.getSession(saved.sessionId);
      if (!project || session?.projectId !== project.id) {
        await this.stop(saved.id);
        continue;
      }
      if (
        project.state !== 'active' ||
        this.blockedProjects.has(project.id) ||
        this.blockedSessions.has(saved.sessionId) ||
        this.stopping.has(saved.id) ||
        this.stopped.has(saved.id)
      )
        continue;
      if (saved.managedInstanceId) {
        const instance = await this.options.store.managedDevServers.getInstance(
          saved.managedInstanceId,
        );
        if (
          !instance ||
          instance.sessionId !== saved.sessionId ||
          instance.projectId !== saved.projectId ||
          !instance.localAccess ||
          instance.networkPort !== saved.networkPort
        ) {
          await this.stop(saved.id);
          continue;
        }
        if (
          instance.desired !== 'running' ||
          !instance.lastRunCommand ||
          !instance.lastRunWorkdir ||
          !(await this.options.store.managedDevServers.isApproved(
            instance.serverId,
            instance.lastRunCommand,
            instance.lastRunWorkdir,
          ))
        )
          continue;
        if (instance.sandboxPort !== saved.targetPort) {
          await this.options.store.updateLocalPreviewShareTarget(saved.id, instance.sandboxPort);
          saved.targetPort = instance.sandboxPort;
        }
      }
      if (this.stopped.has(saved.id)) continue;
      // Keep failed recoveries reserved and durable for the next reconciliation.
      this.reserved.delete(saved.networkPort);
      try {
        const pending = this.createInner(
          saved.sessionId,
          {
            ...(saved.targetPort === null ? {} : { targetPort: saved.targetPort }),
            ...(saved.staticPath === null ? {} : { staticPath: saved.staticPath }),
            networkPort: saved.networkPort,
          },
          saved,
        );
        this.restoring.set(saved.id, pending);
        await pending;
      } catch {
        if (!this.stopping.has(saved.id)) this.reserved.add(saved.networkPort);
      } finally {
        this.restoring.delete(saved.id);
      }
    }
  }
  async reconcile(): Promise<void> {
    await this.restore();
    for (const state of this.active.values()) {
      if (state.provisioning) continue;
      if (!state.ready) {
        await this.release(state.share.id);
        this.reserved.add(state.port);
        continue;
      }
      if (state.share.expiresAt.getTime() <= Date.now()) {
        await this.stop(state.share.id);
        continue;
      }
      const project = await this.options.store.getProject(state.share.projectId);
      const session = await this.options.store.getSession(state.share.sessionId);
      if (!project || session?.projectId !== project.id) {
        await this.stop(state.share.id);
        continue;
      }
      if (project.state !== 'active') {
        await this.release(state.share.id);
        this.reserved.add(state.port);
        continue;
      }
      const saved = this.durable.get(state.share.id);
      if (saved?.managedInstanceId) {
        const instance = await this.options.store.managedDevServers.getInstance(
          saved.managedInstanceId,
        );
        if (
          !instance ||
          instance.sessionId !== state.share.sessionId ||
          instance.projectId !== project.id ||
          !instance.localAccess ||
          instance.networkPort !== state.port
        ) {
          await this.stop(state.share.id);
          continue;
        }
        if (
          instance.desired !== 'running' ||
          instance.sandboxPort !== state.share.targetPort ||
          !instance.lastRunCommand ||
          !instance.lastRunWorkdir ||
          !(await this.options.store.managedDevServers.isApproved(
            instance.serverId,
            instance.lastRunCommand,
            instance.lastRunWorkdir,
          ))
        ) {
          await this.release(state.share.id);
          this.reserved.add(state.port);
          continue;
        }
      }
      try {
        const sandbox = await this.options.docker.inspectContainer(project.containerName);
        if (
          !sandbox.running ||
          containerGenerationOf(sandbox) !== state.generation ||
          !state.connectorId ||
          !(await this.options.docker.inspectContainer(state.connectorId)).running
        ) {
          await this.release(state.share.id);
          this.reserved.add(state.port);
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
            await this.release(state.share.id);
            this.reserved.add(state.port);
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
        state.ready = false;
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.creating]);
    for (const id of this.active.keys()) await this.release(id);
  }
}
