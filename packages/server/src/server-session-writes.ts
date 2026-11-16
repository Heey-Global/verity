import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import type { createServerModels } from './server-models.js';
import type { sharedProjectPeople } from './server-people.js';
import type { createServerVulnerabilities } from './server-vulnerabilities.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import { registerVerityControlSessionRoute } from './verity-control-session-route.js';
import { registerSessionMetadataRoute } from './session-metadata-route.js';
import { registerSessionSeenRoute } from './session-seen-route.js';
import { registerViewStateRoutes } from './view-state-routes.js';
import { registerSessionCreateRoute, type SessionCreateRouteDeps } from './session-create-route.js';
import { registerVulnerabilityFixRoute } from './vulnerability-fix.js';
import { resolveProjectDefaultModel } from './project-agent-policy.js';
import {
  DEFAULT_MODEL,
  PROJECT_MODEL_ERROR,
  UNKNOWN_SANDBOX_UPDATE,
  isProjectSessionModel,
  projectSettingsStore,
  makeBranch,
  isSleepLifecycleState,
} from './server-support.js';

type Models = ReturnType<typeof createServerModels>;
type CreationWiring = Pick<
  SessionCreateRouteDeps,
  | 'worktrees'
  | 'isConfiguredProjectSessionModel'
  | 'advancedModeEnabled'
  | 'ensureVerityControlProject'
  | 'beginProjectSpawn'
  | 'settleBackgroundProvision'
  | 'availableModels'
> &
  Pick<ReturnType<typeof createServerVulnerabilities>, 'presentProject'>;

export function installControlSession(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: Pick<CreationWiring, 'worktrees' | 'advancedModeEnabled' | 'ensureVerityControlProject'> &
    Pick<Models, 'availableModels' | 'isConfiguredProjectSessionModel'>,
): void {
  const { deps } = ctx;
  const {
    worktrees,
    advancedModeEnabled,
    ensureVerityControlProject,
    availableModels,
    isConfiguredProjectSessionModel,
  } = wiring;
  registerVerityControlSessionRoute(app, {
    defaultModel: DEFAULT_MODEL,
    eventStore: deps.eventStore,
    worktrees,
    makeBranch,
    deleteSessionEverywhere: ctx.deleteSession,
    advancedModeEnabled,
    ensureControlProject: ensureVerityControlProject,
    resolveProjectModel: async (projectId, viewer) => {
      const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(projectId);
      // Each person's own default (migration 0217 retired the project-wide one);
      // a project that restricts agents still decides which of them it allows.
      const own = await deps.eventStore.userProviderConnections.projectDefaultModel(
        viewer,
        projectId,
      );
      const model =
        settings?.allowedAgents == null
          ? (own ?? DEFAULT_MODEL)
          : resolveProjectDefaultModel(
              await availableModels({ allowLegacyCodexFallback: true }),
              { ...settings, defaultModel: own },
              isProjectSessionModel,
            );
      return (await isConfiguredProjectSessionModel(model)) ? model : undefined;
    },
  });
}

export function installSessionMetadata(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: Pick<Models, 'projectAgentRejection'> &
    Pick<ReturnType<typeof sharedProjectPeople>, 'choosePersonModel' | 'personalModelRefusal'>,
): void {
  const { deps, conductor } = ctx;
  const { projectAgentRejection, choosePersonModel, personalModelRefusal } = wiring;
  // Edit a session's registry metadata: rename it (set/clear its display name)
  // and/or switch the engine/model it uses. Pure metadata — never touches the
  // durable event log. 404 for an unknown id; 400 for an invalid name, or for a
  // non-Claude/Codex model on a project session (same constraint the turn route
  // enforces).
  //
  // A model switch is a BACKEND HANDOFF and is performed atomically: the route
  // fences new turn submissions, CANCELS any in-flight turn (for every switch,
  // including Claude→Claude — the old process is what has to go, whichever engine
  // replaces it), and only writes the new model plus tears down the old backend once
  // that turn is confirmed finalized. So the response is returned after the handover
  // completed, never before — two backends can never own the worktree at the same
  // time. When termination cannot be confirmed the session keeps its OLD model and
  // the route answers 503 so the client can retry; the model switch is never
  // half-applied.
  //
  // A rename in the SAME request is applied first and independently, so a 503 on the
  // model half still lands it — otherwise the retry would have to guess which half
  // took effect. The 503 body says so.
  //
  // A PATCH naming the model the session already runs is a no-op and skips the
  // handoff entirely: since the handoff cancels the live turn, treating it as a real
  // switch would let a redundant write kill running work.
  registerSessionMetadataRoute(app, {
    store: deps.eventStore,
    runBackendHandoff: (id, handoff) => conductor.runBackendHandoff(id, handoff),
    closeSession: (id) => conductor.closeSession?.(id),
    isModelAllowed: isProjectSessionModel,
    projectModelError: PROJECT_MODEL_ERROR,
    projectAgentRejection: (model, projectId) => projectAgentRejection(model, projectId),
    choosePersonModel,
    personModelRefusal: personalModelRefusal,
  });
  // Advance a session's "last seen" mark for the overview unread dot (#387). The
  // client sends the `eventCount` it just observed when the operator opened the
  // session; the store advances that person's mark monotonically (a stale post can't
  // move it backward) and the value rides back onto every device of theirs via the
  // `lastSeenEventCount` on `GET /sessions`, so the dot clears on all their devices
  // and stays for everyone else.
  // Returns a lightweight ack (the resolved mark) rather than the full summary: the
  // caller discards the body, and building a summary would reload the whole event log
  // just to compute a status/usage nobody here reads. 404 for an unknown session id.
  registerSessionSeenRoute(app, { store: deps.eventStore });
  registerViewStateRoutes(app, { store: deps.eventStore });
}

export function installSessionCreation(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: CreationWiring,
): ReturnType<typeof registerSessionCreateRoute> {
  const { deps, projectsBeingDeleted } = ctx;
  const {
    worktrees,
    isConfiguredProjectSessionModel,
    advancedModeEnabled,
    ensureVerityControlProject,
    beginProjectSpawn,
    settleBackgroundProvision,
    availableModels,
    presentProject,
  } = wiring;
  const sessionCreate = registerSessionCreateRoute(app, {
    eventStore: deps.eventStore,
    mayStartIn: async (viewer, projectId) => {
      if (projectId === null)
        return (await deps.eventStore.isActiveAdministrator(viewer)) ? 'allow' : 'forbidden';
      if (await deps.eventStore.hasProjectPermission(viewer, projectId, 'execute')) return 'allow';
      return (await deps.eventStore.hasProjectPermission(viewer, projectId, 'read'))
        ? 'forbidden'
        : 'not_found';
    },
    ...(deps.dataRoot === undefined ? {} : { dataRoot: deps.dataRoot }),
    ...(deps.provisioner === undefined ? {} : { provisioner: deps.provisioner }),
    ...(deps.projectCloneRoot === undefined ? {} : { projectCloneRoot: deps.projectCloneRoot }),
    ...(deps.projectBackend === undefined ? {} : { projectBackend: deps.projectBackend }),
    ...(deps.secretCipher === undefined ? {} : { secretCipher: deps.secretCipher }),
    ...(deps.projectWorktrees === undefined ? {} : { projectWorktrees: deps.projectWorktrees }),
    ...(deps.refreshProjectToken === undefined
      ? {}
      : { refreshProjectToken: deps.refreshProjectToken }),
    projectSettingsStore: () => projectSettingsStore(deps.eventStore),
    worktrees,
    isConfiguredProjectSessionModel,
    advancedModeEnabled,
    ensureVerityControlProject,
    projectsBeingDeleted,
    beginProjectSpawn,
    settleBackgroundProvision,
    makeBranch,
    isProjectSessionModel,
    availableModels,
    deleteSessionEverywhere: ctx.deleteSession,
    PROJECT_MODEL_ERROR,
    isSleepLifecycleState,
    publicProject: (project) => presentProject(project, null, UNKNOWN_SANDBOX_UPDATE, null),
    defaultModel: DEFAULT_MODEL,
  });
  return sessionCreate;
}

export function installVulnerabilityFix(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: { sessionCreate: ReturnType<typeof registerSessionCreateRoute> } & Pick<
    ReturnType<typeof createServerSessionOverview>,
    'sessionPrCache'
  >,
): void {
  const { deps, conductor, sessionsBeingReaped } = ctx;
  const { sessionCreate, sessionPrCache } = wiring;
  registerVulnerabilityFixRoute(app, {
    store: deps.eventStore,
    spawn: sessionCreate.spawn,
    pullRequest: (session) => sessionPrCache.get(session),
    dispatch: async (sessionId, prompt, userId, displayPrompt, requestKey) => {
      if (sessionsBeingReaped.has(sessionId)) throw new Error('Session is being deleted.');
      const durableDispatchId = `vulnerability-fix:${sessionId}:${requestKey}`;
      await deps.eventStore.reserveBackgroundDispatch(durableDispatchId, sessionId);
      const result = await conductor.dispatchTurnWhenIdle(
        sessionId,
        prompt,
        {},
        {
          displayPrompt,
          durableDispatchId,
          ...(userId ? { initiatedBy: { userId } } : {}),
        },
      );
      if (!result.accepted)
        throw Object.assign(new Error('The fix session is busy. Retry when it is idle.'), {
          statusCode: 409,
        });
    },
  });
}
