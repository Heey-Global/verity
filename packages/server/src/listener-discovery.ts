import { spawn, type ChildProcess } from 'node:child_process';
import type { EventBus } from '@verity/session';
import type { EventStore, ProjectRecord } from '@verity/store';
import { containerPathFor, dockerHostFor } from './project-backend.js';
import { projectClonePath } from './provisioner.js';
import {
  sessionDevServers,
  type ListeningProcess,
  type SessionDevServer,
} from './listening-ports.js';
import { PreviewShareNotFoundError } from './preview-share-manager.js';

/** One sandbox watcher serves every session, independently of public sharing. */
export class ListenerDiscovery {
  private readonly watchers = new Map<string, { child: ChildProcess; containerName: string }>();
  private readonly healthy = new Map<string, ListeningProcess[]>();
  private readonly snapshots = new Map<string, string>();
  private readonly dirty = new Map<string, ProjectRecord>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly options: {
      eventStore: EventStore;
      bus: EventBus;
      hostCloneRoot: string;
      resolveSessionProject?: (sessionId: string, project: ProjectRecord) => Promise<ProjectRecord>;
      sandboxWorktree?: (project: ProjectRecord, worktree: string) => string;
      dockerBaseUrl?: string;
      resolveUser?: (project: ProjectRecord) => Promise<string | undefined>;
      scan: (project: ProjectRecord) => Promise<ListeningProcess[]>;
      /** Sees every successful scan, e.g. to stop orphaned managed servers. */
      onScan?: (project: ProjectRecord, processes: ListeningProcess[]) => void;
    },
  ) {
    this.unsubscribe = options.bus.subscribeAll((sessionId, frame) => {
      if (frame.event.t === 'tool_result') void this.refreshSession(sessionId);
    });
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 10_000);
    this.timer.unref();
  }

  async listSessionDevServers(sessionId: string): Promise<SessionDevServer[]> {
    const session = await this.options.eventStore.getSession(sessionId);
    if (!session?.projectId) throw new PreviewShareNotFoundError('project session not found');
    const storedProject = await this.options.eventStore.getProject(session.projectId);
    const project =
      storedProject && this.options.resolveSessionProject
        ? await this.options.resolveSessionProject(sessionId, storedProject)
        : storedProject;
    if (!project) throw new PreviewShareNotFoundError('project not found');
    if (!this.active(project)) return [];
    if (!this.options.resolveSessionProject) await this.watch(project);
    let processes: ListeningProcess[];
    try {
      processes = await this.options.scan(project);
      this.healthy.set(project.containerName, processes);
    } catch {
      processes = this.healthy.get(project.containerName) ?? [];
    }
    return this.attribute(project, sessionId, processes);
  }

  private async attribute(
    project: ProjectRecord,
    sessionId: string,
    processes: readonly ListeningProcess[],
  ): Promise<SessionDevServer[]> {
    if (this.options.resolveSessionProject) {
      return sessionDevServers(
        processes.filter((process) => !process.sessionId || process.sessionId === sessionId),
        '/work',
        sessionId,
      ).map((server) => ({ ...server, scope: 'session' as const, sessionId }));
    }
    const sessions = (await this.options.eventStore.listSessions()).filter(
      (s) => s.projectId === project.id && s.worktree,
    );
    const paths = sessions
      .flatMap((session) => {
        try {
          return [
            {
              id: session.sessionId,
              path: containerPathFor(
                session.worktree,
                projectClonePath(this.options.hostCloneRoot, project),
              ),
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.path.length - a.path.length);
    const own = paths.find((path) => path.id === sessionId);
    if (!own) return [];
    const attributed = processes.map((process) => {
      const owner =
        paths.find((path) => path.id === process.sessionId) ??
        paths.find((path) => process.cwd === path.path || process.cwd.startsWith(`${path.path}/`));
      return { process, owner };
    });
    return attributed.flatMap(({ process, owner }) => {
      if (owner && owner.id !== sessionId) return [];
      const server = sessionDevServers(
        [{ ...process, sessionId }],
        owner?.path ?? process.cwd,
        sessionId,
      )[0];
      return server
        ? [
            {
              ...server,
              reachable: process.bind === 'loopback' || server.reachable,
              scope: owner ? ('session' as const) : ('project' as const),
              ...(owner ? { sessionId: owner.id } : {}),
            },
          ]
        : [];
    });
  }

  private async refreshSession(sessionId: string): Promise<void> {
    try {
      if (this.options.resolveSessionProject) {
        const servers = await this.listSessionDevServers(sessionId);
        const snapshot = JSON.stringify(servers);
        const persisted = await this.options.eventStore.getLatestDevServersEvent(sessionId);
        const previous =
          this.snapshots.get(sessionId) ?? JSON.stringify(persisted?.devServers ?? []);
        if (snapshot === previous || this.closed) return;
        this.snapshots.set(sessionId, snapshot);
        const event = { t: 'dev_servers_changed' as const, devServers: servers };
        const { seq, ts } = await this.options.eventStore.appendEvent(sessionId, event);
        this.options.bus.publish(sessionId, { seq, ts, event });
        return;
      }
      const session = await this.options.eventStore.getSession(sessionId);
      if (session?.projectId) {
        const project = await this.options.eventStore.getProject(session.projectId);
        if (project) await this.refresh(project);
      }
    } catch {
      /* Discovery must not interrupt a completed agent tool. */
    }
  }

  /** Rescans a project now, for changes Verity made itself (managed dev servers). */
  refreshProject(project: ProjectRecord): Promise<void> {
    if (this.options.resolveSessionProject) {
      return this.options.eventStore
        .listSessions()
        .then(async (sessions) => {
          for (const session of sessions.filter((session) => session.projectId === project.id))
            await this.refreshSession(session.sessionId);
        })
        .catch(() => undefined);
    }
    return this.refresh(project).catch(() => undefined);
  }

  private refresh(project: ProjectRecord): Promise<void> {
    const existing = this.pending.get(project.id);
    if (existing) {
      this.dirty.set(project.id, project);
      return existing;
    }
    const operation = (async () => {
      const current = await this.options.eventStore.getProject(project.id);
      if (!current) return;
      project = current;
      let processes: ListeningProcess[];
      try {
        processes = this.active(project) ? await this.options.scan(project) : [];
        this.healthy.set(project.id, processes);
        this.options.onScan?.(project, processes);
      } catch {
        return;
      }
      for (const session of (await this.options.eventStore.listSessions()).filter(
        (s) => s.projectId === project.id,
      )) {
        const devServers = await this.attribute(project, session.sessionId, processes);
        const snapshot = JSON.stringify(devServers);
        let previous = this.snapshots.get(session.sessionId);
        if (previous === undefined) {
          // Re-emitting the first scan after every restart silently marks all
          // sessions unread even though their listeners have not changed.
          const persisted = await this.options.eventStore.getLatestDevServersEvent(
            session.sessionId,
          );
          previous = JSON.stringify(persisted?.devServers ?? []);
          this.snapshots.set(session.sessionId, previous);
        }
        if (previous === snapshot || this.closed) continue;
        const event = { t: 'dev_servers_changed' as const, devServers };
        const { seq, ts } = await this.options.eventStore.appendEvent(session.sessionId, event);
        this.snapshots.set(session.sessionId, snapshot);
        this.options.bus.publish(session.sessionId, { seq, ts, event });
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.pending.delete(project.id);
        const latest = this.dirty.get(project.id);
        this.dirty.delete(project.id);
        if (latest && !this.closed) void this.refresh(latest);
      });
    this.pending.set(project.id, operation);
    return operation;
  }

  private active(project: ProjectRecord): boolean {
    return Boolean(
      project.containerName && project.state === 'active' && project.kind !== 'control_plane',
    );
  }

  private async watch(project: ProjectRecord): Promise<void> {
    if (this.closed || !this.active(project)) return;
    const existing = this.watchers.get(project.id);
    if (existing?.containerName === project.containerName) return;
    if (existing) {
      existing.child.stdin?.end();
      existing.child.kill();
    }
    // Keep the inspection inside one exec; only changed snapshots cross Docker.
    const script = `const fs=require('node:fs');let last='';function tick(){try{const sockets=['/proc/net/tcp','/proc/net/tcp6'].flatMap(p=>{try{return fs.readFileSync(p,'utf8').split('\\n').filter(l=>l.trim().split(/\\s+/)[3]==='0A')}catch{return[]}}).sort();let hints='';try{hints=fs.readdirSync('/tmp/verity-dev-servers/announcements').sort().map(f=>{try{return fs.readFileSync('/tmp/verity-dev-servers/announcements/'+f,'utf8')}catch{return''}}).join('')}catch{}try{hints+=fs.statSync('/tmp/verity-dev-servers/scan-request').mtimeMs}catch{}const value=JSON.stringify([sockets,hints]);if(value!==last){last=value;process.stdout.write('changed\\n')}}catch{process.exit(1)}}tick();setInterval(tick,1500);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
    const user = await this.options.resolveUser?.(project);
    if (this.closed || !this.active(project)) return;
    if (this.watchers.get(project.id)?.containerName === project.containerName) return;
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        ...(user ? ['--user', user] : []),
        project.containerName,
        'node',
        '-e',
        script,
      ],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          ...process.env,
          ...(this.options.dockerBaseUrl
            ? { DOCKER_HOST: dockerHostFor(this.options.dockerBaseUrl) }
            : {}),
        },
      },
    );
    this.watchers.set(project.id, { child, containerName: project.containerName });
    child.stdout?.on('data', () => {
      void this.refresh(project);
    });
    const finish = () => {
      if (this.watchers.get(project.id)?.child === child) this.watchers.delete(project.id);
    };
    child.once('exit', finish);
    child.once('error', finish);
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.options.resolveSessionProject) {
        for (const session of await this.options.eventStore.listSessions())
          if (session.projectId) await this.refreshSession(session.sessionId);
        return;
      }
      const projects = await this.options.eventStore.listProjects();
      for (const [id, watcher] of this.watchers) {
        const project = projects.find((candidate) => candidate.id === id);
        if (!project || !this.active(project) || project.containerName !== watcher.containerName) {
          watcher.child.stdin?.end();
          watcher.child.kill();
          this.watchers.delete(id);
          this.healthy.delete(id);
          if (project) await this.refresh(project);
        }
      }
      for (const project of projects) if (this.active(project)) await this.watch(project);
    } catch {
      /* Retry discovery after the store or Docker recovers. */
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    for (const { child } of this.watchers.values()) {
      child.stdin?.end();
      child.kill();
    }
    this.watchers.clear();
  }
}
