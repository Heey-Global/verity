import { installOverviewEvents } from './live/overview-events.js';
import { DomainEventBus } from './live/domain-events.js';
import { installAssistantHandoffNotices } from './assistant-handoff-notify.js';
import { installChangeSubmissions } from './change-submissions.js';
import {
  startServerMessageProjection,
  createServerConductor,
  createServerEventPublisher,
  createServerWorktrees,
} from './server-runtime.js';
import { installInfrastructureRoutes } from './server-infrastructure-routes.js';
import { createServerMonitor, installServerMonitoring } from './metrics/server-monitor.js';
import {
  installControlSession,
  installSessionMetadata,
  installSessionCreation,
  installVulnerabilityFix,
} from './server-session-writes.js';
import { installProjectContext, installUserContext } from './server-context-routes.js';
import { createServerWikiProposals } from './server-wiki-proposals.js';
import { installTasks } from './server-tasks.js';
import { installKnowledge } from './server-knowledge.js';
import { installPreviews } from './server-previews.js';
import { installRepositoryTools } from './server-repository-tools.js';
import {
  createServerPush,
  createServerPushRuntime,
  startServerPush,
  registerPushShutdown,
} from './server-push.js';
import { registerServerShutdownDrain, createServerQueueRecovery } from './server-queue-recovery.js';
import {
  createServerAgentCredentials,
  createServerUsage,
  installProviderUsage,
} from './server-agent-credentials.js';
import {
  createServerProjectRuntime,
  createServerProjectSandboxRuntime,
} from './server-project-runtime.js';
import { installWikiMaintenance } from './server-wiki-maintenance.js';
import { createServerVulnerabilities } from './server-vulnerabilities.js';
import { createServerAuthority } from './server-authority.js';
import { createServerAutomations } from './server-automations.js';
import { createServerModels } from './server-models.js';
import { createServerScheduling } from './server-scheduling.js';
import { type FastifyInstance } from 'fastify';
import { createServerSessionOverview } from './server-session-overview.js';
import { createServerInquiryTool, installProjectInquiries } from './server-project-inquiries.js';
import { installConnections } from './server-connections.js';
import { createServerSessionDesign, installSessionDesign } from './server-session-design.js';
import type { ServerDeps } from './server-deps.js';
import { registerServerMcpRoutes } from './server-mcp-routes.js';
import { type ServerContext } from './server-context.js';
import { createSessionDeletion, installSessionDeletion } from './server-session-deletion.js';
import { installProjects } from './server-projects.js';
import { installPeople, peopleDirectQueries, sharedProjectPeople } from './server-people.js';
import { installProjectPullRequests } from './server-project-pull-requests.js';
import { createPrRepairTurns } from './server-pr-repair.js';
import { installRepairSupervision, installRepairRoutes } from './server-repair-supervision.js';
import { installSessionRoutes } from './server-session-routes.js';
import { installAssistant } from './server-assistant.js';
import {
  createLiveTickets,
  createServerLiveHub,
  installLive,
  createLiveResources,
  registerLiveRevocation,
  registerLiveSessionHints,
} from './server-live.js';
import { createServerApp, installHttpGuards } from './server-http.js';
import { installOnboarding } from './server-onboarding.js';
import {
  installSessionAttachments,
  installSessionHistory,
  installSessionList,
  installSessionReads,
} from './server-session-reads.js';
import { installSettings } from './server-settings.js';
import {
  createMeetingTranscripts,
  installMeetingIntake,
  installMeetings,
} from './server-meetings.js';
import {
  isProjectSessionModel,
  SERVER_VERSION,
  projectSettingsStore,
  isControlPlaneProject,
  VERITY_CONTROL_PROJECT_ID,
  makeBranch,
} from './server-support.js';
import './fastify-augmentation.js';
export type { ServerUpdateController } from './server-update-routes.js';
export { VERITY_CONTROL_SESSION_NAME } from './verity-control-session-route.js';
export type {
  ProjectSettingsRecord,
  PublicProjectRecord,
  SessionDetail,
  SessionListEnvelope,
  SessionSummary,
  SpawnResult,
} from './server-types.js';

export type { ServerDeps } from './server-deps.js';

export {
  appendMeetingIndex,
  CommandMeetingTranscriber,
  meetingTranscriptionSettingsWhileSealed,
  removeCancelledMeetingTranscript,
  type MeetingTranscriber,
  type MeetingTranscriptResult,
} from './meeting-transcription.js';
export {
  SERVER_VERSION,
  startProjectRelayMigrationScheduler,
  CLAUDE_MODELS,
  DEFAULT_MODEL,
  sortModelIds,
  VERITY_CONTROL_PROJECT_ID,
  VERITY_CONTROL_SYSTEM_PROMPT,
  isAttachmentBase64SizeAllowed,
  isAttachmentBase64TotalSizeAllowed,
  redactScrollDiagnosticEvent,
  redactScrollDiagnosticData,
} from './server-support.js';

export function buildServer(deps: ServerDeps): FastifyInstance {
  const liveTickets = createLiveTickets(deps);
  startServerMessageProjection(deps);
  const { app, lifecycle, preAuthKeys, trafficLedger } = createServerApp(deps);
  const monitor =
    deps.serverMonitor ?? createServerMonitor({ store: undefined, version: SERVER_VERSION });
  installServerMonitoring(app, monitor);
  const conductor = createServerConductor(app, deps);
  const publishSessionEvent = createServerEventPublisher(deps);
  const sessionDesign = createServerSessionDesign(deps, {
    conductor,
    sessionsBeingReaped: () => sessionsBeingReaped,
  });
  const { sessionPlanning, sessionMockups } = sessionDesign;
  const {
    projectsBeingDeleted,
    sessionsBeingReaped,
    projectDeletesInFlight,
    beginProjectSpawn,
    settleProjectSpawns,
    afterProjectProvision,
    settleBackgroundProvision,
  } = createServerProjectRuntime(app, deps, conductor, {
    hasMeetingJob: (sessionId) => hasMeetingJob(sessionId),
    vulnerabilityService: () => vulnerabilityService,
  });
  const { pushSender, describePushSession, describePushSessionById } = createServerPush(app, deps);
  const resources = createLiveResources(app, deps, lifecycle);
  const domainEvents = new DomainEventBus();
  const liveHub = createServerLiveHub(app, deps, {
    resources,
    lifecycle,
    trafficLedger,
    domainEvents,
  });
  const ctx: ServerContext = {
    app,
    deps,
    lifecycle,
    conductor,
    liveHub,
    domainEvents,
    resources,
    pushSender,
    monitor,
    projectsBeingDeleted,
    sessionsBeingReaped,
    deleteSession: createSessionDeletion({ app, deps }),
  };
  registerLiveSessionHints(app, ctx);
  installOverviewEvents(app, ctx);
  const { pushRouter, pushFirePoints, wikiMaintenanceSessions, unsubscribePushFirePoints } =
    createServerPushRuntime(app, ctx, { describePushSessionById });
  const { schedulingTool } = createServerScheduling(app, ctx, { pushRouter, pushFirePoints });
  const serverUpdateNotifier = startServerPush(app, ctx);
  registerLiveRevocation(ctx, liveTickets);

  registerPushShutdown(ctx, {
    unsubscribePushFirePoints,
    serverUpdateNotifier,
    pushFirePoints,
    stopVulnerabilityPush: () => stopVulnerabilityPush(),
  });
  registerServerShutdownDrain(ctx);

  const { canExecuteAs, runningTurnInitiator, assistantToolDeps } = createServerAuthority(ctx);
  const stopHandoffNotices = installAssistantHandoffNotices({
    eventStore: deps.eventStore,
    bus: deps.bus,
    pushRouter,
    permitted: (...args) => assistantToolDeps.permitted(...args),
    log: app.log,
  });
  lifecycle.onClose(() => {
    stopHandoffNotices();
  });
  const automations = createServerAutomations(app, ctx, { canExecuteAs, models: () => models });

  const {
    service: vulnerabilityService,
    sessions: vulnerabilitySessions,
    presentProject,
    stopPush: stopVulnerabilityPush,
  } = createServerVulnerabilities(app, ctx, {
    fixPullRequest: (session) => sessionPrCache.get(session),
  });

  const { projectActivity, isProjectBusy } = createServerProjectSandboxRuntime(ctx);
  const { storeAgentCredentials, persistPersonal, agentLogin, administratorAccounts } =
    createServerAgentCredentials(ctx);
  // `sessionPrStatus` comes from the session overview further down, which itself
  // takes `maybeDispatchPrRepairTurns`, so the repair turns read it lazily.
  const {
    reconcileSessionRepairs,
    maybeDispatchPrRepairTurns,
    repairTerminated,
    preparingRepairDispatches,
  } = createPrRepairTurns(ctx, {
    canExecuteAs,
    sessionPrStatus: (session) => sessionPrStatus(session),
  });
  const { recoverQueuedTurns } = createServerQueueRecovery(app, ctx);
  const worktrees = createServerWorktrees(deps);
  const { dbClaudeOAuthTokenProvider, claudeUsage, codexUsage } = createServerUsage(
    app,
    ctx,
    storeAgentCredentials,
  );
  const meetingTranscripts = createMeetingTranscripts(app, deps);
  const { hasMeetingJob, cancelMeetingJobs } = meetingTranscripts;

  installHttpGuards(app, ctx, { preAuthKeys });

  installInfrastructureRoutes(app, ctx);

  const {
    prunePrSummaryCache,
    pruneBranchCache,
    liveStatus,
    prSummaryCache,
    compactPr,
    applyPrSummaryAction,
    sessionPrCache,
    sessionPrStatus,
    summarizeSessions,
    emptyProjectionFacts,
    projectionEventsFor,
    latestRateLimitsFromSequenced,
    liveStatusFromProjection,
    sessionResumable,
    activityBusyCache,
    activityLogBusy,
    AWAITING,
    branchesForSession,
    currentBranchCached,
    summarizeSession,
    readBranchMetadata,
    localMergeTarget,
    prCleanupPending,
    withPrVisibility,
    invalidatePrSummaryAction,
    invalidateBranchCache,
    resolvePullRequests,
  } = createServerSessionOverview({
    conductor,
    deps,
    app,
    resources,
    reconcileSessionRepairs,
    sessionsBeingReaped,
    maybeDispatchPrRepairTurns,
    pushRouter,
    pushFirePoints,
    describePushSession,
    vulnerabilitySessions,
  });

  const { readSecretStatus } = installSessionList(app, ctx, {
    codexUsage,
    wikiMaintenanceSessions,
    sessionOverview: { prunePrSummaryCache, pruneBranchCache, summarizeSessions, sessionPrCache },
  });

  installProviderUsage(app, ctx, { claudeUsage, codexUsage });

  installSettings(app, ctx, {
    storeAgentCredentials,
    agentLogin,
    recoverQueuedTurns,
    dbClaudeOAuthTokenProvider,
    readSecretStatus,
    // Declared further down; read only when a request arrives.
    availableModels: () => availableModels(),
  });
  installRepositoryTools(app, ctx, branchesForSession);
  installUserContext(app, ctx);
  installPeople(ctx, { agentLogin, persistPersonal, administratorAccounts });
  installProjectContext(app, ctx);
  const { wikiProposals, installWikiFiles } = createServerWikiProposals(app, ctx);
  const decidePendingLinkedMessage = registerServerMcpRoutes({
    wikiProposals,
    inquiryTool: createServerInquiryTool(ctx, () => projectInquiries),
    coordinationSpawn: () => sessionCreate.spawn,
    deps,
    app,
    conductor,
    assistantToolDeps,
    summarizeSession,
    sessionResumable,
    schedulingTool,
    runningTurnInitiator,
    projectsBeingDeleted,
    beginProjectSpawn,
    availableModels: (...args) => availableModels(...args),
    isConfiguredProjectSessionModel: (...args) => isConfiguredProjectSessionModel(...args),
    liveStatus,
    branchesForSession,
    prSummaryCache,
    vulnerabilityService,
    canExecuteAs,
    sessionPlanning,
    sessionMockups,
    publishSessionEvent,
    projectSettingsStore,
    isProjectSessionModel,
    isControlPlaneProject,
    makeBranch,
    SERVER_VERSION,
    VERITY_CONTROL_PROJECT_ID,
  });
  installSessionDesign(app, ctx, sessionDesign);
  automations.installRoutes();

  installPreviews(app, ctx);

  const { advancedModeEnabled, ensureVerityControlProject } = installProjects(app, ctx, {
    presentProject,
    projectActivity,
    hasMeetingJob,
    summarizeSessions,
    projectsBeingDeleted,
    sessionsBeingReaped,
    projectDeletesInFlight,
    settleProjectSpawns,
    afterProjectProvision,
    settleBackgroundProvision,
  });
  installKnowledge(app, ctx, {
    availableModels: () => availableModels(),
    projectDefaultModel: (projectId) => projectDefaultModel(projectId),
  });
  installConnections(app, ctx);

  installControlSession(app, ctx, {
    worktrees,
    advancedModeEnabled,
    ensureVerityControlProject,
    availableModels: (...args) => availableModels(...args),
    isConfiguredProjectSessionModel: (...args) => isConfiguredProjectSessionModel(...args),
  });

  const models = createServerModels(ctx);
  const {
    availableModels,
    projectAgentRejection,
    projectDefaultModel,
    isConfiguredProjectSessionModel,
  } = models;

  const {
    sharedProject,
    personSessionModel,
    projectPeopleNames,
    choosePersonModel,
    personalModelRefusal,
  } = sharedProjectPeople(ctx, { availableModels });
  installSessionReads(app, ctx, {
    hasMeetingJob,
    sessionOverview: {
      emptyProjectionFacts,
      projectionEventsFor,
      latestRateLimitsFromSequenced,
      liveStatusFromProjection,
      sessionResumable,
    },
    availableModels,
    personSessionModel,
    projectPeopleNames,
  });

  const { directQueryFor, instanceClaudeServes } = peopleDirectQueries(ctx, availableModels);
  installTasks(app, ctx, {
    availableModels,
    isConfiguredProjectSessionModel,
    projectAgentRejection,
    personSessionModel,
    directQueryFor,
    instanceClaudeServes,
    publishSessionEvent,
  });
  const { attendeeMeetings } = installMeetings(app, ctx, {
    assistantToolDeps,
    meetingTranscripts,
    availableModels,
    personSessionModel,
    directQueryFor,
    instanceClaudeServes,
  });
  installWikiFiles();

  installSessionAttachments(app, ctx);

  installSessionHistory(app, ctx, {
    hasMeetingJob,
    sessionOverview: {
      activityBusyCache,
      activityLogBusy,
      AWAITING,
      branchesForSession,
      currentBranchCached,
    },
  });

  installSessionMetadata(app, ctx, {
    projectAgentRejection,
    choosePersonModel,
    personalModelRefusal,
  });

  installSessionDeletion(app, ctx, { worktrees, hasMeetingJob });

  const sessionCreate = installSessionCreation(app, ctx, {
    worktrees,
    isConfiguredProjectSessionModel,
    advancedModeEnabled,
    ensureVerityControlProject,
    beginProjectSpawn,
    settleBackgroundProvision,
    availableModels,
    presentProject,
  });
  const projectInquiries = installProjectInquiries(app, ctx, {
    authorized: canExecuteAs,
    spawn: sessionCreate.spawn,
  });
  installVulnerabilityFix(app, ctx, { sessionCreate, sessionPrCache });
  installChangeSubmissions(app, ctx, {
    publish: publishSessionEvent,
    // Uncommitted work is not in HEAD, so HEAD is not what was submitted.
    revision: async (session) => {
      const branches = await branchesForSession(session);
      if (!branches || (await branches.isDirty(session.worktree))) return undefined;
      return branches.headRevision?.(session.worktree);
    },
    pullRequest: async (session) => (await sessionPrCache.get(session)) ?? undefined,
    freshPullRequest: async (session) => {
      const status = await sessionPrStatus(session);
      if (status?.observationFailed === true) throw new Error('pull request unavailable');
      return status ?? undefined;
    },
    hasChanges: async (session) => {
      const branches = await branchesForSession(session);
      if (!branches || session.projectId === null) return undefined;
      // A local project has no remote base to compare with; unknown offers submitting.
      if ((await deps.eventStore.getProject(session.projectId))?.kind === 'local') return undefined;
      const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(
        session.projectId,
      );
      const base = `origin/${settings?.defaultBranch ?? 'main'}`;
      return branches.hasProjectChanges(session.worktree, base);
    },
  });
  installMeetingIntake(app, ctx, { attendeeMeetings, spawn: sessionCreate.spawn });

  installRepairRoutes(app, ctx);
  installAssistant(app, ctx, {
    assistantToolDeps,
    summarizeSession,
    ensureVerityControlProject,
    availableModels,
    sessionCreate,
  });
  // One fix session per pull request: concurrent taps of "Fix" in this process
  // wait for the first, and the durable origin record covers everything else.
  installProjectPullRequests(ctx, { sessionCreate, sessionPrCache });
  installRepairSupervision(app, ctx, {
    canExecuteAs,
    sessionPrStatus,
    branchesForSession,
    spawn: sessionCreate.spawn,
    repairTerminated,
    preparingRepairDispatches,
  });

  installOnboarding(app, ctx, { spawn: sessionCreate.spawn });

  installWikiMaintenance(app, ctx, {
    spawn: sessionCreate.spawn,
    isProjectBusy,
    wikiMaintenanceSessions,
  });

  installSessionRoutes(app, ctx, {
    sessionOverview: {
      compactPr,
      applyPrSummaryAction,
      sessionPrCache,
      sessionPrStatus,
      branchesForSession,
      readBranchMetadata,
      localMergeTarget,
      prCleanupPending,
      withPrVisibility,
      invalidatePrSummaryAction,
      invalidateBranchCache,
      resolvePullRequests,
    },
    beginProjectSpawn,
    pushFirePoints,
    maybeDispatchPrRepairTurns,
    hasMeetingJob,
    cancelMeetingJobs,
    decidePendingLinkedMessage,
    projectAgentRejection,
    isConfiguredProjectSessionModel,
    sharedProject,
    personSessionModel,
  });

  installLive(app, ctx, { tickets: liveTickets });

  return app;
}
