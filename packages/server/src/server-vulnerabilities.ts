import type { ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { containerPathFor } from './project-backend.js';
import { projectClonePath } from './provisioner.js';
import type { ServerContext } from './server-context.js';
import type { PublicProjectRecord } from './server-types.js';
import { emptyProjectSettings, publicProject } from './server-support.js';
import { startVulnerabilityPush } from './vulnerability-push.js';
import { registerVulnerabilityRoutes } from './vulnerability-routes.js';
import { canWakeForScan, vulnerabilitySandboxLease } from './vulnerability-sandbox.js';
import {
  createVulnerabilityScanService,
  type VulnerabilityScanService,
} from './vulnerability-scan.js';
import { startVulnerabilityScheduler } from './vulnerability-scheduler.js';
import { createVulnerabilitySessionMonitor } from './vulnerability-session.js';

interface VulnerabilityOptions {
  fixPullRequest: NonNullable<Parameters<typeof registerVulnerabilityRoutes>[1]['fixPullRequest']>;
}

interface VulnerabilityRuntime {
  service: VulnerabilityScanService;
  sessions: ReturnType<typeof createVulnerabilitySessionMonitor>;
  presentProject: (...args: Parameters<typeof publicProject>) => PublicProjectRecord;
  stopPush: () => Promise<void>;
}

export function createServerVulnerabilities(
  app: FastifyInstance,
  ctx: ServerContext,
  { fixPullRequest }: VulnerabilityOptions,
): VulnerabilityRuntime {
  const { deps, lifecycle, resources, conductor, pushSender } = ctx;
  const vulnerabilityService = createVulnerabilityScanService({
    logFailure: (data) => app.log.warn(data, 'verity: vulnerability scan job failed'),
    store: deps.eventStore.vulnerabilityScans,
    getProject: (id) => deps.eventStore.getProject(id),
    getSession: (id) => deps.eventStore.getSession(id),
    sessionPath: (session, project) => {
      if (!deps.projectCloneRoot) throw new Error('Project clone root unavailable');
      return containerPathFor(session.worktree, projectClonePath(deps.projectCloneRoot, project));
    },
    canWakeSleeping: canWakeForScan(deps.provisioner),
    ...(deps.provisioner?.projectSandboxLastActivityAt &&
    deps.provisioner.tryBeginProjectSandboxActivity &&
    deps.provisioner.endProjectSandboxActivity
      ? {
          acquireSandbox: vulnerabilitySandboxLease({
            provisioner: deps.provisioner,
            getProject: (id) => deps.eventStore.getProject(id),
            warn: (error) =>
              app.log.warn({ err: error }, 'Vulnerability scan sandbox restoration failed'),
          }),
        }
      : {}),
    beginActivity: (id) => {
      if (deps.provisioner?.tryBeginProjectSandboxActivity?.(id) === false) return undefined;
      return () => deps.provisioner?.endProjectSandboxActivity?.(id);
    },
    ...(deps.projectRuntime?.runAutomationScript
      ? {
          runScript: (project: ProjectRecord, script: string) =>
            deps.projectRuntime!.runAutomationScript!(project, emptyProjectSettings(project.id), {
              workdir: '/work',
              script,
              timeoutMs: 120_000,
              maxOutputBytes: 8 * 1024 * 1024,
            }),
        }
      : {}),
    changed: (id, sessionId) => {
      resources.invalidate(`/projects/${encodeURIComponent(id)}/vulnerability-scan`);
      if (sessionId)
        resources.invalidate(`/sessions/${encodeURIComponent(sessionId)}/vulnerability-scan`);
      void vulnerabilitySessions.rebuild();
    },
  });
  const vulnerabilitySessions = createVulnerabilitySessionMonitor({
    getProject: (id) => deps.eventStore.getProject(id),
    store: deps.eventStore.vulnerabilityScans,
    service: vulnerabilityService,
    getSession: (id) => deps.eventStore.getSession(id),
    listSessions: () => deps.eventStore.listSessions(),
    isBusy: (id) => conductor.isBusy(id),
    changed: () => {
      resources.invalidate('/sessions');
      resources.invalidate('/projects');
    },
    warn: (err) => app.log.warn({ err }, 'Vulnerability session update failed'),
  });
  void vulnerabilitySessions.rebuild();
  const unsubscribeVulnerabilityTurns = deps.bus.subscribeAll((id, { event }) => {
    if (event.t === 'result' || event.t === 'interrupted') vulnerabilitySessions.schedule(id);
  });
  const vulnerabilityPush = pushSender
    ? startVulnerabilityPush({
        store: deps.eventStore,
        sender: pushSender,
        warn: (err) => app.log.warn({ err }, 'Vulnerability push failed'),
      })
    : undefined;

  const presentProject = (...args: Parameters<typeof publicProject>): PublicProjectRecord => ({
    ...publicProject(...args),
    vulnerabilitySummary: vulnerabilitySessions.projects.get(args[0].id),
  });
  const vulnerabilityScheduler = startVulnerabilityScheduler({
    store: deps.eventStore.vulnerabilityScans,
    listProjects: () => deps.eventStore.listProjects(),
    scan: (id) => vulnerabilityService.scan(id, { refresh: true }),
    accepts: (project) => vulnerabilityService.accepts(project),
    log: app.log,
  });
  registerVulnerabilityRoutes(app, {
    eventStore: deps.eventStore,
    service: vulnerabilityService,
    fixPullRequest,
    fixLiveState: (id) =>
      conductor.pendingPermissions(id).length
        ? 'needs_attention'
        : conductor.isBusy(id)
          ? 'in_progress'
          : undefined,
    settingsChanged: () => {
      vulnerabilityScheduler.wake();
      void vulnerabilitySessions.rebuild();
    },
  });
  lifecycle.onClose(async () => {
    vulnerabilityScheduler.stop();
    unsubscribeVulnerabilityTurns();
    await vulnerabilitySessions.stop();
    await vulnerabilityService.stop();
  });

  return {
    service: vulnerabilityService,
    sessions: vulnerabilitySessions,
    presentProject,
    // The sender's close hook owns this stop so it is awaited before sender shutdown.
    stopPush: async () => {
      await vulnerabilityPush?.stop();
    },
  };
}
