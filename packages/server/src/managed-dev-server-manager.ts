import {
  ManagedDevServerConflictError,
  ManagedDevServerInputError,
  ManagedDevServerPortsFullError,
  type EventStore,
  type ManagedDevServerInstanceRecord,
  type ManagedDevServerRecord,
  type ProjectRecord,
} from '@verity/store';
import type { ListeningProcess } from './listening-ports.js';
import type { LocalPreviewShare } from './local-preview-manager.js';

/** Sandbox ports Verity hands out to managed instances. Internal only. */
const MANAGED_SANDBOX_PORTS: readonly number[] = Array.from(
  { length: 1000 },
  (_, index) => 41_000 + index,
);
/** A server that has not answered on its port by then is reported crashed. */
export const MANAGED_STARTUP_DEADLINE_MS = 60_000;
const MONITOR_INTERVAL_MS = 2_000;
/** Marks an instance whose start waits for its sandbox to wake. Supervision
 *  launches it as soon as the sandbox is up, whatever an earlier run left behind. */
const WAKING_DETAIL = 'Waking sandbox…';
/** A running server off its port this long, with its processes alive, is crashed. */
export const MANAGED_SILENT_LIMIT_MS = 30_000;
const MANAGED_SHARE_TTL_SECONDS = 30 * 86_400;

export type StartedBy = 'agent' | 'operator' | 'recovery';

export interface ManagedDevServerRuntime {
  startManagedServer(
    project: ProjectRecord,
    input: {
      instanceId: string;
      command: string;
      worktree: string;
      workdir: string;
      env: Record<string, string>;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  stopManagedServer(project: ProjectRecord, instanceId: string): Promise<void>;
  managedServerStatus(
    project: ProjectRecord,
    instanceId: string,
  ): Promise<{ alive: boolean; exitCode: number | null }>;
  managedServerLogs(project: ProjectRecord, instanceId: string, lines?: number): Promise<string>;
  listListeningProcesses(project: ProjectRecord): Promise<ListeningProcess[]>;
}

/** The subset of the local preview manager a managed instance publishes through. */
export interface ManagedLocalShares {
  create(
    sessionId: string,
    input: { targetPort: number; ttlSeconds: number; networkPort: number },
  ): Promise<LocalPreviewShare>;
  stop(id: string): Promise<boolean>;
  list(sessionId: string): LocalPreviewShare[];
  heldPorts(): Map<number, LocalPreviewShare>;
  portOf(shareId: string): number | undefined;
}

export interface ManagedDevServerManagerOptions {
  store: EventStore;
  runtime: ManagedDevServerRuntime;
  /** Absent when local previews are unavailable; entries then run without an address. */
  localShares?: ManagedLocalShares | undefined;
  /** The local preview range, the only ports anyone sees. */
  networkPorts: readonly number[];
  /** The session worktree as the sandbox sees it. */
  sandboxWorktree(project: ProjectRecord, worktree: string): string;
  /** Instances whose public link is live and must keep their network port. */
  protectedInstances?: () => ReadonlySet<string>;
  /** Pushes a refreshed listener snapshot to the app. */
  refreshListeners?: (project: ProjectRecord) => Promise<void> | void;
  /** Wakes a sleeping sandbox (ADR 0020) so a start does not fail on it. */
  wakeSandbox?: (projectId: string, sessionId: string) => Promise<unknown>;
  now?: () => number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface ManagedInstanceView {
  id: string;
  sessionId: string;
  state: ManagedDevServerInstanceRecord['state'];
  desired: ManagedDevServerInstanceRecord['desired'];
  detail: string | null;
  /** The network address; set while the instance is published locally. */
  url: string | null;
  localShareId: string | null;
  /** Internal; the app uses it only as a share target and never displays it. */
  sandboxPort: number;
  /** True while running without the operator's approval for local publishing. */
  awaitingApproval: boolean;
  /** The Local switch: on while the operator wants it published on the network. A
   *  crash keeps it as it was; an unapproved command never reads as on. */
  localOn: boolean;
  /** The running command differs from the entry's current one. */
  restartToApply: boolean;
  startedAt: string | null;
}

export interface ManagedServerView {
  id: string;
  name: string;
  command: string;
  workdir: string;
  approved: boolean;
  /** This Core has the Local and Shared online switches (`/local`, `local` on
   *  start and approve). Lets newer apps fall back on older Cores. */
  accessSwitches: true;
  /** This session's instance, if the entry ever ran here. */
  instance: ManagedInstanceView | null;
  /** Running or starting instances in other sessions of the project. */
  elsewhere: Array<{ instanceId: string; sessionId: string; sessionName: string | null }>;
}

export class ManagedDevServerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ManagedDevServerError';
  }
}

interface SessionContext {
  project: ProjectRecord;
  sessionId: string;
  worktree: string;
}

/**
 * Runs dev servers the agent set up (concept 2.6): starts them in a session's
 * worktree, tells starting from running from crashed by watching the tagged
 * listener, publishes them on the operator's network once approved, and brings
 * them back after a sandbox is recreated.
 */
export class ManagedDevServerManager {
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private ticking: Promise<void> | undefined;
  private reserved = new Set<number>();
  /** One mutation or supervision pass per project at a time, so a stop never
   *  races a pass that still believes the server should run. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Publishing that failed waits before the next attempt instead of every tick. */
  private readonly publishRetryAt = new Map<string, number>();
  /** Running instances whose listener vanished while processes stayed alive. */
  private readonly missingSince = new Map<string, number>();
  /** Recent recovery starts per instance; a server killed hard over and over is
   *  reported instead of being restarted forever. */
  private readonly recoveries = new Map<string, number[]>();
  /** Last periodic status check per running instance (log trimming). */
  private readonly checkedAt = new Map<string, number>();
  /** Projects with an instance that should be running; they must not sleep. */
  private activeProjects = new Set<string>();
  private closed = false;

  constructor(private readonly options: ManagedDevServerManagerOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => void this.tick(), MONITOR_INTERVAL_MS);
    this.timer.unref?.();
    void this.refreshReserved();
  }

  /** Running entries keep the sandbox awake, as an active share does (ADR 0020). */
  hasRunningServers(projectId: string): boolean {
    return this.activeProjects.has(projectId);
  }

  /** Network ports reserved for instances; the ad hoc share allocator skips them. */
  reservedNetworkPorts(): ReadonlySet<number> {
    return this.reserved;
  }

  private locked<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    this.locks.set(projectId, settled);
    void settled.then(() => {
      if (this.locks.get(projectId) === settled) this.locks.delete(projectId);
    });
    return next;
  }

  private refreshQuietly(project: ProjectRecord): void {
    void Promise.resolve()
      .then(() => this.options.refreshListeners?.(project))
      .catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private get servers() {
    return this.options.store.managedDevServers;
  }

  private async refreshReserved(): Promise<void> {
    try {
      this.reserved = await this.servers.reservedNetworkPorts();
    } catch {
      /* Keep the previous snapshot; the next reservation refreshes it. */
    }
  }

  private async context(sessionId: string): Promise<SessionContext> {
    const session = await this.options.store.getSession(sessionId);
    if (!session?.projectId || !session.worktree)
      throw new ManagedDevServerError('session not found', 404);
    const project = await this.options.store.getProject(session.projectId);
    if (!project) throw new ManagedDevServerError('project not found', 404);
    return { project, sessionId, worktree: session.worktree };
  }

  private async entry(projectId: string, idOrName: string): Promise<ManagedDevServerRecord> {
    const byId = await this.servers.get(idOrName);
    if (byId && byId.projectId === projectId) return byId;
    let byName: ManagedDevServerRecord | undefined;
    try {
      byName = await this.servers.getByName(projectId, idOrName);
    } catch {
      byName = undefined;
    }
    if (!byName) throw new ManagedDevServerError(`no server named "${idOrName}"`, 404);
    return byName;
  }

  private urlFor(instance: ManagedDevServerInstanceRecord): string | null {
    const share = this.shareFor(instance);
    return share?.url ?? null;
  }

  private shareFor(instance: ManagedDevServerInstanceRecord): LocalPreviewShare | undefined {
    const local = this.options.localShares;
    if (!local || instance.networkPort === null) return undefined;
    const share = local.heldPorts().get(instance.networkPort);
    return share && share.sessionId === instance.sessionId ? share : undefined;
  }

  // ---- entries ----------------------------------------------------------

  async view(sessionId: string): Promise<ManagedServerView[]> {
    const { project } = await this.context(sessionId);
    const [entries, instances, sessions] = await Promise.all([
      this.servers.list(project.id),
      this.servers.listInstances({ projectId: project.id }),
      this.options.store.listSessions(),
    ]);
    const names = new Map(sessions.map((session) => [session.sessionId, session.name ?? null]));
    return entries.map((entry) => {
      const own = instances.find(
        (instance) => instance.serverId === entry.id && instance.sessionId === sessionId,
      );
      return {
        id: entry.id,
        name: entry.name,
        command: entry.command,
        workdir: entry.workdir,
        approved: entry.approved,
        accessSwitches: true as const,
        instance: own ? this.instanceView(entry, own) : null,
        elsewhere: instances
          .filter(
            (instance) =>
              instance.serverId === entry.id &&
              instance.sessionId !== sessionId &&
              (instance.state === 'running' || instance.state === 'starting'),
          )
          .map((instance) => ({
            instanceId: instance.id,
            sessionId: instance.sessionId,
            sessionName: names.get(instance.sessionId) ?? null,
          })),
      };
    });
  }

  private instanceView(
    entry: ManagedDevServerRecord,
    instance: ManagedDevServerInstanceRecord,
  ): ManagedInstanceView {
    const url = instance.state === 'running' ? this.urlFor(instance) : null;
    return {
      id: instance.id,
      sessionId: instance.sessionId,
      state: instance.state,
      desired: instance.desired,
      detail: instance.detail,
      url,
      localShareId: url ? (this.shareFor(instance)?.id ?? null) : null,
      sandboxPort: instance.sandboxPort,
      awaitingApproval:
        instance.state === 'running' && url === null && !this.ranApproved(entry, instance),
      localOn:
        instance.localAccess &&
        this.ranApproved(entry, instance) &&
        (instance.desired === 'running' || instance.state === 'crashed'),
      restartToApply:
        (instance.state === 'running' || instance.state === 'starting') &&
        (instance.lastRunCommand !== entry.command || instance.lastRunWorkdir !== entry.workdir),
      startedAt: instance.startedAt?.toISOString() ?? null,
    };
  }

  /** Approval for what actually runs, not for the entry's current command. */
  private ranApproved(entry: ManagedDevServerRecord, instance: ManagedDevServerInstanceRecord) {
    return (
      entry.approved &&
      instance.lastRunCommand === entry.command &&
      instance.lastRunWorkdir === entry.workdir
    );
  }

  async add(
    sessionId: string,
    input: { name: string; command: string; workdir?: string | undefined },
  ): Promise<ManagedDevServerRecord> {
    const { project } = await this.context(sessionId);
    return this.translate(() => this.servers.create({ projectId: project.id, ...input }));
  }

  async update(
    sessionId: string,
    idOrName: string,
    patch: {
      name?: string | undefined;
      command?: string | undefined;
      workdir?: string | undefined;
    },
  ): Promise<ManagedDevServerRecord> {
    const { project } = await this.context(sessionId);
    const entry = await this.entry(project.id, idOrName);
    const updated = await this.translate(() => this.servers.update(entry.id, patch));
    if (!updated) throw new ManagedDevServerError('server not found', 404);
    return updated;
  }

  /** Stops every instance of the entry, then deletes it and with it all its ports. */
  async remove(sessionId: string, idOrName: string): Promise<void> {
    const { project } = await this.context(sessionId);
    const entry = await this.entry(project.id, idOrName);
    await this.locked(project.id, async () => {
      for (const instance of await this.servers.listInstances({ serverId: entry.id }))
        await this.stopInstance(project, instance, 'Entry removed');
      await this.servers.delete(entry.id);
    });
    await this.refreshReserved();
  }

  /** The operator approves exactly what they were shown. */
  async approve(
    sessionId: string,
    idOrName: string,
    seen: { command: string; workdir: string },
    options: { local?: boolean | undefined } = {},
  ): Promise<ManagedServerView[]> {
    const { project } = await this.context(sessionId);
    const entry = await this.entry(project.id, idOrName);
    const approved = await this.servers.approve(entry.id, seen);
    if (!approved)
      throw new ManagedDevServerError(
        'The command changed in the meantime. Review it again before approving.',
        409,
      );
    await this.locked(project.id, async () => {
      let instance = (await this.servers.listInstances({ serverId: entry.id, sessionId }))[0];
      // Approved from Shared online: the operator agreed to a public link, not
      // to opening the server on the network.
      if (instance && options.local === false) {
        instance =
          (await this.servers.updateInstance(instance.id, { localAccess: false })) ?? instance;
        // Still published from an earlier approved run: that address goes too.
        await this.unpublish(instance);
      }
      if (instance?.state === 'running') await this.publish(project, approved, instance);
    });
    return this.view(sessionId);
  }

  private async translate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ManagedDevServerConflictError)
        throw new ManagedDevServerError(error.message, 409);
      if (error instanceof ManagedDevServerInputError)
        throw new ManagedDevServerError(error.message, 400);
      throw error;
    }
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * `local` is the operator's Local switch for this start: true from the Local
   * switch, false when Shared online starts the server alone. Absent, a running
   * instance keeps what it had; an agent start of a stopped one without a live
   * public link turns Local on, so no server runs with no access left and
   * nothing to stop it.
   */
  async start(
    sessionId: string,
    idOrName: string,
    by: StartedBy,
    options: { local?: boolean | undefined } = {},
  ): Promise<ManagedServerView> {
    const context = await this.context(sessionId);
    const entry = await this.entry(context.project.id, idOrName);
    if (by === 'operator') {
      // Switching an entry on is the operator's own act and approves what runs,
      // after the app showed the command (first approval goes through approve()).
      if (!entry.approved)
        throw new ManagedDevServerError('Review and approve the command first', 409);
    }
    await this.locked(context.project.id, () => this.startEntry(context, entry, by, options.local));
    return this.viewOf(sessionId, entry.id);
  }

  /**
   * The Local switch. On starts the server if needed and publishes it; off ends
   * local access and, when no public link is left either, stops the server.
   */
  async setLocal(sessionId: string, idOrName: string, on: boolean): Promise<ManagedServerView> {
    const context = await this.context(sessionId);
    const { project } = context;
    const entry = await this.entry(project.id, idOrName);
    if (on && !entry.approved)
      throw new ManagedDevServerError('Review and approve the command first', 409);
    await this.locked(project.id, async () => {
      const instance = (await this.servers.listInstances({ serverId: entry.id, sessionId }))[0];
      if (on) {
        // Only a live process of the approved command gets the flag; anything
        // else starts, crashed included, and an older command restarts.
        if (
          instance &&
          !this.ranApproved(entry, instance) &&
          (instance.state === 'running' || instance.state === 'starting')
        )
          await this.stopInstance(project, instance, null);
        else if (instance && (instance.state === 'running' || instance.state === 'starting')) {
          const updated = await this.servers.updateInstance(instance.id, { localAccess: true });
          if (updated?.state === 'running') await this.publish(project, entry, updated);
          return;
        }
        await this.startEntry(context, entry, 'operator', true);
        return;
      }
      if (!instance) return;
      await this.servers.updateInstance(instance.id, { localAccess: false });
      await this.unpublish(instance);
      if (!(await this.hasLivePublicLink(instance)))
        await this.stopInstance(project, instance, null);
      else this.refreshQuietly(project);
    });
    return this.viewOf(sessionId, entry.id);
  }

  /**
   * A public link of a managed instance ended: stopped by the operator, expired,
   * or removed by the Uplink. With Local off nothing is left that anyone can
   * open, so the server stops instead of running unnoticed.
   */
  async publicLinkEnded(instanceId: string): Promise<void> {
    const instance = await this.servers.getInstance(instanceId).catch(() => undefined);
    if (!instance || instance.localAccess || instance.desired !== 'running') return;
    const project = await this.options.store.getProject(instance.projectId);
    if (!project) return;
    await this.locked(project.id, async () => {
      const current = await this.servers.getInstance(instanceId);
      if (!current || current.localAccess || current.desired !== 'running') return;
      if (await this.hasLivePublicLink(current)) return;
      await this.stopInstance(project, current, null);
    }).catch(() => undefined);
  }

  private async hasLivePublicLink(instance: ManagedDevServerInstanceRecord): Promise<boolean> {
    const shares = await this.options.store.listPublicPreviewShares(instance.projectId);
    const now = this.now();
    return shares.some(
      (share) =>
        share.managedInstanceId === instance.id &&
        (share.state === 'creating' || share.state === 'active') &&
        share.expiresAt.getTime() > now,
    );
  }

  async restart(sessionId: string, idOrName: string, by: StartedBy): Promise<ManagedServerView> {
    const context = await this.context(sessionId);
    const entry = await this.entry(context.project.id, idOrName);
    // Refuse before stopping: a restart that cannot start must not kill what runs.
    if (by === 'operator' && !entry.approved)
      throw new ManagedDevServerError('Review and approve the command first', 409);
    await this.locked(context.project.id, async () => {
      const instance = (await this.servers.listInstances({ serverId: entry.id, sessionId }))[0];
      if (instance) await this.stopInstance(context.project, instance, null);
      // Restart keeps the switches; with both off it turns Local on.
      const local =
        instance && !instance.localAccess && (await this.hasLivePublicLink(instance))
          ? undefined
          : true;
      await this.startEntry(context, entry, by, by === 'operator' ? local : undefined);
    });
    return this.viewOf(sessionId, entry.id);
  }

  async stop(
    sessionId: string,
    idOrName: string,
    options: { onlyIfUnshared?: boolean | undefined } = {},
  ): Promise<ManagedServerView> {
    const { project } = await this.context(sessionId);
    const entry = await this.entry(project.id, idOrName);
    await this.locked(project.id, async () => {
      const instance = (await this.servers.listInstances({ serverId: entry.id, sessionId }))[0];
      if (
        instance &&
        options.onlyIfUnshared &&
        (instance.localAccess || (await this.hasLivePublicLink(instance)))
      )
        return;
      if (instance) await this.stopInstance(project, instance, null);
    });
    return this.viewOf(sessionId, entry.id);
  }

  /** Stops an instance in another session of the same project, from the list row. */
  async stopElsewhere(sessionId: string, instanceId: string): Promise<ManagedServerView[]> {
    const { project } = await this.context(sessionId);
    const instance = await this.servers.getInstance(instanceId);
    if (!instance || instance.projectId !== project.id)
      throw new ManagedDevServerError('instance not found', 404);
    await this.locked(project.id, () => this.stopInstance(project, instance, null));
    return this.view(sessionId);
  }

  /** One entry, resolved by id or by name the same way start and stop resolve it. */
  async status(sessionId: string, idOrName: string): Promise<ManagedServerView> {
    const { project } = await this.context(sessionId);
    const entry = await this.entry(project.id, idOrName);
    return this.viewOf(sessionId, entry.id);
  }

  async logs(sessionId: string, idOrName: string, lines = 300): Promise<string> {
    const { project } = await this.context(sessionId);
    const entry = await this.entry(project.id, idOrName);
    const instance = (await this.servers.listInstances({ serverId: entry.id, sessionId }))[0];
    if (!instance) return '';
    return this.options.runtime.managedServerLogs(project, instance.id, lines);
  }

  /**
   * Called before a session is deleted or moved: its processes must not outlive
   * its worktree. A move also forgets the instances, which belong to the source
   * project and would otherwise hold their network ports forever.
   */
  async stopSession(sessionId: string, options: { forget?: boolean } = {}): Promise<void> {
    const instances = await this.servers.listInstances({ sessionId });
    const session = await this.options.store.getSession(sessionId);
    const project = session?.projectId
      ? await this.options.store.getProject(session.projectId)
      : undefined;
    const work = async () => {
      for (const instance of instances) {
        if (project) await this.stopInstance(project, instance, null).catch(() => undefined);
        if (options.forget) await this.servers.deleteInstance(instance.id);
      }
    };
    if (project) await this.locked(project.id, work);
    else await work();
    await this.refreshReserved();
  }

  private async viewOf(sessionId: string, serverId: string): Promise<ManagedServerView> {
    const view = (await this.view(sessionId)).find((server) => server.id === serverId);
    if (!view) throw new ManagedDevServerError('server not found', 404);
    return view;
  }

  private async startEntry(
    context: SessionContext,
    entry: ManagedDevServerRecord,
    by: StartedBy,
    local?: boolean,
  ): Promise<void> {
    const { project, sessionId } = context;
    if ((project.state === 'sleeping' || project.state === 'waking') && this.options.wakeSandbox) {
      // Record the intent, wake the sandbox, and let supervision start the server
      // once it is up: an instance that should run but has no process is started.
      const instance = await this.servers.ensureInstance({
        serverId: entry.id,
        sessionId,
        sandboxPorts: MANAGED_SANDBOX_PORTS,
      });
      const access =
        local ?? (by === 'agent' && !(await this.hasLivePublicLink(instance)) ? true : undefined);
      await this.servers.updateInstance(instance.id, {
        ...(access !== undefined ? { localAccess: access } : {}),
        desired: 'running',
        state: 'starting',
        detail: WAKING_DETAIL,
        lastRunCommand: entry.command,
        lastRunWorkdir: entry.workdir,
        startedAt: new Date(this.now()),
      });
      this.activeProjects.add(project.id);
      void this.options
        .wakeSandbox(project.id, sessionId)
        .catch((error: unknown) =>
          this.servers.updateInstance(instance.id, {
            desired: 'stopped',
            state: 'crashed',
            detail: `The sandbox did not wake: ${error instanceof Error ? error.message : String(error)}`,
          }),
        )
        .catch(() => undefined);
      return;
    }
    if (project.state !== 'active' || !project.containerName)
      throw new ManagedDevServerError('the project sandbox is not running', 409);
    const processes = await this.options.runtime.listListeningProcesses(project).catch(() => []);
    const busy = new Set(processes.map((process) => process.port));
    let instance = await this.servers.ensureInstance({
      serverId: entry.id,
      sessionId,
      sandboxPorts: MANAGED_SANDBOX_PORTS,
      avoid: busy,
    });
    if (local !== undefined && instance.localAccess !== local)
      instance =
        (await this.servers.updateInstance(instance.id, { localAccess: local })) ?? instance;
    if (local === false) await this.unpublish(instance);
    const status = await this.options.runtime
      .managedServerStatus(project, instance.id)
      .catch(() => ({ alive: false, exitCode: null }));
    if (status.alive && (instance.state === 'running' || instance.state === 'starting')) {
      // Already up after a wake: drop the marker so supervision stops relaunching.
      if (instance.detail === WAKING_DETAIL)
        await this.servers.updateInstance(instance.id, { detail: null });
      this.activeProjects.add(project.id);
      return;
    }
    if (
      local === undefined &&
      by === 'agent' &&
      !instance.localAccess &&
      !(await this.hasLivePublicLink(instance))
    )
      instance =
        (await this.servers.updateInstance(instance.id, { localAccess: true })) ?? instance;
    if (status.alive) await this.options.runtime.stopManagedServer(project, instance.id);
    const holder = processes.find((process) => process.port === instance.sandboxPort);
    if (holder && holder.instanceId !== instance.id) {
      const moved = await this.servers.moveSandboxPort(instance.id, MANAGED_SANDBOX_PORTS, busy);
      if (moved) instance = moved;
    }
    const command = by === 'recovery' ? (instance.lastRunCommand ?? entry.command) : entry.command;
    const workdir = by === 'recovery' ? (instance.lastRunWorkdir ?? entry.workdir) : entry.workdir;
    const siblings = await this.siblingEnv(project, sessionId, entry.id);
    const result = await this.options.runtime.startManagedServer(project, {
      instanceId: instance.id,
      command: command.replaceAll('{port}', String(instance.sandboxPort)),
      worktree: this.options.sandboxWorktree(project, context.worktree),
      workdir,
      env: {
        ...siblings,
        PORT: String(instance.sandboxPort),
        VERITY_SESSION_ID: sessionId,
      },
    });
    const now = new Date(this.now());
    if (!result.ok) {
      await this.servers.updateInstance(instance.id, {
        desired: 'stopped',
        state: 'crashed',
        detail: result.reason,
        lastRunCommand: command,
        lastRunWorkdir: workdir,
      });
      return;
    }
    this.activeProjects.add(project.id);
    await this.servers.updateInstance(instance.id, {
      desired: 'running',
      state: 'starting',
      detail: null,
      lastRunCommand: command,
      lastRunWorkdir: workdir,
      startedAt: now,
      lastRanAt: now,
    });
    this.options.log?.('verity: managed dev server starting', {
      projectId: project.id,
      sessionId,
      serverId: entry.id,
      by,
    });
  }

  /** `VERITY_SERVER_<NAME>_URL` for each other running entry of the session. */
  private async siblingEnv(
    project: ProjectRecord,
    sessionId: string,
    exceptServerId: string,
  ): Promise<Record<string, string>> {
    const [entries, instances] = await Promise.all([
      this.servers.list(project.id),
      this.servers.listInstances({ sessionId }),
    ]);
    const env: Record<string, string> = {};
    for (const instance of instances) {
      if (instance.serverId === exceptServerId) continue;
      if (instance.state !== 'running' && instance.state !== 'starting') continue;
      const entry = entries.find((value) => value.id === instance.serverId);
      if (entry)
        env[`VERITY_SERVER_${entry.nameKey}_URL`] =
          `http://127.0.0.1:${String(instance.sandboxPort)}`;
    }
    return env;
  }

  private async stopInstance(
    project: ProjectRecord,
    instance: ManagedDevServerInstanceRecord,
    detail: string | null,
  ): Promise<void> {
    await this.servers.updateInstance(instance.id, { desired: 'stopped' });
    await this.unpublish(instance);
    if (project.state === 'active' && project.containerName)
      await this.options.runtime.stopManagedServer(project, instance.id).catch(() => undefined);
    await this.servers.updateInstance(instance.id, {
      state: 'stopped',
      detail,
      ...(instance.state === 'running' ? { lastRanAt: new Date(this.now()) } : {}),
    });
    this.refreshQuietly(project);
  }

  // ---- publishing -------------------------------------------------------

  private async publish(
    project: ProjectRecord,
    entry: ManagedDevServerRecord,
    instance: ManagedDevServerInstanceRecord,
  ): Promise<void> {
    const local = this.options.localShares;
    if (!local || !instance.localAccess) return;
    if (
      !instance.lastRunCommand ||
      !instance.lastRunWorkdir ||
      !(await this.servers.isApproved(entry.id, instance.lastRunCommand, instance.lastRunWorkdir))
    )
      return;
    const existing = this.shareFor(instance);
    if (
      existing &&
      existing.targetPort === instance.sandboxPort &&
      existing.expiresAt.getTime() - this.now() > 86_400_000
    )
      return;
    // A share close to its end is replaced on the same port; the local manager
    // would otherwise hand the old one back unchanged.
    if (existing) await this.options.localShares?.stop(existing.id).catch(() => false);
    if ((this.publishRetryAt.get(instance.id) ?? 0) > this.now()) return;
    const held = local.heldPorts();
    const externallyUsed = new Set(
      [...held.entries()]
        .filter(
          ([port, share]) =>
            port !== instance.networkPort || share.sessionId !== instance.sessionId,
        )
        .map(([port]) => port),
    );
    let reservation: { port: number; evictedInstanceId?: string };
    try {
      reservation = await this.servers.reserveNetworkPort(instance.id, this.options.networkPorts, {
        protect: this.options.protectedInstances?.() ?? new Set(),
        externallyUsed,
      });
    } catch (error) {
      if (error instanceof ManagedDevServerPortsFullError) {
        await this.servers.updateInstance(instance.id, {
          detail:
            'All network ports are in use. Stop another server or enlarge VERITY_LOCAL_PREVIEW_PORT_RANGE.',
        });
        return;
      }
      throw error;
    }
    await this.refreshReserved();
    try {
      await local.create(instance.sessionId, {
        targetPort: instance.sandboxPort,
        ttlSeconds: MANAGED_SHARE_TTL_SECONDS,
        networkPort: reservation.port,
      });
      this.publishRetryAt.delete(instance.id);
      if (instance.detail) await this.servers.updateInstance(instance.id, { detail: null });
    } catch (error) {
      // Most likely an ad hoc share took the port in the same instant. Release
      // it so the next attempt reserves a free one, and say why in the meantime.
      await this.servers.releaseNetworkPort(instance.id);
      await this.refreshReserved();
      this.publishRetryAt.set(instance.id, this.now() + 30_000);
      await this.servers.updateInstance(instance.id, {
        detail: 'Could not open it on your network yet. Retrying shortly.',
      });
      this.options.log?.('verity: managed dev server could not publish locally', {
        projectId: project.id,
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async unpublish(instance: ManagedDevServerInstanceRecord): Promise<void> {
    const share = this.shareFor(instance);
    if (share) await this.options.localShares?.stop(share.id).catch(() => false);
  }

  /**
   * Stops tagged processes whose instance no longer exists, for example after a
   * delete path that removed the rows without stopping the processes first.
   * Fed by every listener scan of the project.
   */
  sweepOrphans(project: ProjectRecord, processes: readonly ListeningProcess[]): Promise<void> {
    const tags = new Set(
      processes.flatMap((process) => (process.instanceId ? [process.instanceId] : [])),
    );
    if (tags.size === 0 || this.closed) return Promise.resolve();
    return this.locked(project.id, async () => {
      // Anything tagged that should not run: deleted rows, and instances stopped
      // while the sandbox was paused, whose processes survived the resume.
      const wanted = new Set(
        (await this.servers.listInstances({ projectId: project.id, desired: 'running' })).map(
          (value) => value.id,
        ),
      );
      for (const tag of tags)
        if (!wanted.has(tag))
          await this.options.runtime.stopManagedServer(project, tag).catch(() => undefined);
    }).catch(() => undefined);
  }

  // ---- supervision ------------------------------------------------------

  /** One pass over active instances. Exposed for tests and for discovery pushes. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ticking ??= this.supervise().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async supervise(): Promise<void> {
    let instances: ManagedDevServerInstanceRecord[];
    try {
      instances = await this.servers.listInstances({ desired: 'running' });
    } catch {
      return;
    }
    const byProject = new Map<string, ManagedDevServerInstanceRecord[]>();
    for (const instance of instances)
      byProject.set(instance.projectId, [...(byProject.get(instance.projectId) ?? []), instance]);
    this.activeProjects = new Set(byProject.keys());
    for (const [projectId, group] of byProject) {
      try {
        await this.locked(projectId, () => this.superviseProject(projectId, group));
      } catch (error) {
        this.options.log?.('verity: managed dev server supervision failed', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async superviseProject(
    projectId: string,
    instances: ManagedDevServerInstanceRecord[],
  ): Promise<void> {
    const project = await this.options.store.getProject(projectId);
    if (!project || project.state !== 'active' || !project.containerName) return;
    const processes = await this.options.runtime.listListeningProcesses(project);
    let changed = false;
    for (const snapshot of instances) {
      // Re-read under the project lock: a stop since the pass began wins.
      const instance = await this.servers.getInstance(snapshot.id);
      if (!instance || instance.desired !== 'running') continue;
      const entry = await this.servers.get(instance.serverId);
      if (!entry) continue;
      if (instance.state === 'starting' && instance.detail === WAKING_DETAIL) {
        const session = await this.options.store.getSession(instance.sessionId);
        if (session?.worktree) {
          await this.startEntry(
            { project, sessionId: instance.sessionId, worktree: session.worktree },
            entry,
            'recovery',
          );
          changed = true;
        }
        continue;
      }
      const tagged = processes.filter((process) => process.instanceId === instance.id);
      const onPort = tagged.find((process) => process.port === instance.sandboxPort);
      if (onPort) {
        this.missingSince.delete(instance.id);
        if (this.now() - (this.checkedAt.get(instance.id) ?? 0) > 60_000) {
          // The status check also trims an oversized log; once a minute is enough.
          this.checkedAt.set(instance.id, this.now());
          await this.options.runtime
            .managedServerStatus(project, instance.id)
            .catch(() => undefined);
        }
        if (instance.state !== 'running') {
          await this.servers.updateInstance(instance.id, { state: 'running', detail: null });
          changed = true;
        }
        const current = (await this.servers.getInstance(instance.id)) ?? instance;
        await this.publish(project, entry, current);
        continue;
      }
      const status = await this.options.runtime
        .managedServerStatus(project, instance.id)
        .catch(() => ({ alive: true, exitCode: null }));
      const elapsed = this.now() - (instance.startedAt?.getTime() ?? 0);
      if (!status.alive && status.exitCode === null && elapsed > 5_000) {
        // Nothing runs and no exit was recorded: the sandbox was recreated and its
        // /tmp is gone. Start again with what last ran; a pending update waits for
        // the operator's next restart.
        const recent = (this.recoveries.get(instance.id) ?? []).filter(
          (at) => this.now() - at < 10 * 60_000,
        );
        if (recent.length >= 3) {
          this.recoveries.delete(instance.id);
          await this.unpublish(instance);
          await this.servers.updateInstance(instance.id, {
            desired: 'stopped',
            state: 'crashed',
            detail: 'The server was stopped from outside several times, possibly out of memory',
          });
          changed = true;
          continue;
        }
        this.recoveries.set(instance.id, [...recent, this.now()]);
        const session = await this.options.store.getSession(instance.sessionId);
        if (session?.worktree) {
          await this.startEntry(
            { project, sessionId: instance.sessionId, worktree: session.worktree },
            entry,
            'recovery',
          );
          changed = true;
        }
        continue;
      }
      // Just launched: the launcher may not be visible yet.
      if (!status.alive && status.exitCode === null) continue;
      const timedOut = instance.state === 'starting' && elapsed > MANAGED_STARTUP_DEADLINE_MS;
      let silent = false;
      if (instance.state === 'running' && status.alive) {
        // A restarting server is briefly off its port; one that stays off while
        // its processes live (a parent outliving its crashed child) is not running.
        const since = this.missingSince.get(instance.id) ?? this.now();
        this.missingSince.set(instance.id, since);
        silent = this.now() - since > MANAGED_SILENT_LIMIT_MS;
      }
      if (status.alive && !timedOut && !silent) continue;
      this.missingSince.delete(instance.id);
      const elsewhere = tagged[0];
      const detail = !status.alive
        ? status.exitCode === null
          ? 'The server exited'
          : `The server exited with code ${String(status.exitCode)}`
        : silent
          ? 'Stopped answering on its port'
          : elsewhere
            ? `Did not answer on its port: it listens on ${String(elsewhere.port)} instead. Use $PORT or {port} in the command.`
            : 'Did not answer on its port within 60 seconds';
      await this.unpublish(instance);
      if (status.alive)
        await this.options.runtime.stopManagedServer(project, instance.id).catch(() => undefined);
      await this.servers.updateInstance(instance.id, {
        desired: 'stopped',
        state: 'crashed',
        detail,
        ...(instance.state === 'running' ? { lastRanAt: new Date(this.now()) } : {}),
      });
      changed = true;
    }
    if (changed) this.refreshQuietly(project);
  }
}
