import type { administratorProviderConnections } from './administrator-provider-connections.js';
import { fetchOpenCodeModels } from './opencode-model-catalog.js';
import { registerProviderConnectionRoutes } from './provider-connection-routes.js';
import { registerProjectTeamRoutes } from './project-team-routes.js';
import { registerTeamJoinRoutes } from './team-join-routes.js';
import { createMemberRevocation } from './member-revocation.js';
import { listDopplerProjectSecretNames } from './doppler-secret-resolver.js';
import { registerDopplerConnectionRoutes } from './doppler-connection-routes.js';
import { registerUserProfileRoutes } from './user-profile-routes.js';
import { registerGitHubUserRoutes } from './github-user-routes.js';
import { mintPersonalSigningKey, registerGitIdentityRoutes } from './git-identity-routes.js';
import { createGitHubUserAuthorization } from './github-user-authorization.js';
import { CODEX_DEFAULT_MODEL } from '@verity/session';
import type { EventStore, ProviderConnectionKind } from '@verity/store';
import { createClaudeUsageService } from './claudeUsage.js';
import { createCodexUsageService } from './codexUsage.js';
import { createLiveMeetingAnalysisQuery } from './live-meeting-analysis-query.js';
import { selectedOpenCodeModels } from './opencode-model-selection.js';
import { isModelAllowedForProject } from './project-agent-policy.js';
import { preselectModel } from './session-create-route.js';
import { legacyAdministratorId } from './view-state-routes.js';
import { personModelRefusal } from './turn-sandbox.js';
import {
  isProjectSessionModel,
  veritySettingsStore,
  projectSettingsStore,
} from './server-support.js';
import type { ServerContext } from './server-context.js';
import type { AgentLoginService } from './agent-login.js';
import type { ModelList } from './server-types.js';

// People in shared projects, as the Server wires them (ADR 0023): each person's own
// accounts, models and settings routes. Installed from buildServer
// (docs/adr/0029-module-boundaries-and-file-size.md).

type AvailableModels = (options?: {
  allowLegacyCodexFallback?: boolean;
  viewer?: string | undefined;
}) => Promise<ModelList>;

/**
 * Each person's own quota probes (ADR 0023 §3): the instance probes are the
 * administrator's, every other person gets one probe pair for the server's lifetime.
 */
export function personalUsageProbes(ctx: ServerContext) {
  const { app, deps } = ctx;
  const personalUsage = new Map<
    string,
    {
      claudeUsage: ReturnType<typeof createClaudeUsageService>;
      codexUsage: ReturnType<typeof createCodexUsageService>;
    }
  >();
  return (viewer: string) => {
    if (viewer === legacyAdministratorId) return undefined;
    const known = personalUsage.get(viewer);
    if (known !== undefined) return known;
    const probes = {
      claudeUsage: createClaudeUsageService({
        log: app.log,
        tokenProvider: () =>
          deps.personalClaudeAccessToken?.(viewer).catch(() => undefined) ??
          Promise.resolve(undefined),
      }),
      codexUsage: createCodexUsageService({
        log: app.log,
        credentialProvider: deps.codexGatewayCredentialFor?.(viewer),
      }),
    };
    personalUsage.set(viewer, probes);
    return probes;
  };
}

/**
 * Which provider accounts serve a person's turns (ADR 0023 §3): their own, and
 * the instance logins only for the administrator they belonged to. Without a
 * person — background work — the instance logins, as before.
 */
export async function modelAccounts(store: EventStore, viewer: string | undefined) {
  const settings = (await veritySettingsStore(store).getVeritySettingsRaw()) ?? null;
  const usesInstance = viewer === undefined || viewer === legacyAdministratorId;
  const own = viewer === undefined ? [] : await store.userProviderConnections.status(viewer);
  const owns = (provider: string) => own.some((connection) => connection.provider === provider);
  const ownOpenCode = own.find((connection) => connection.provider === 'opencode');
  const instanceOpenCode =
    settings?.opencodeBaseUrl?.trim() && settings.opencodeApiKey?.trim()
      ? selectedOpenCodeModels(settings)
      : [];
  return {
    claude:
      owns('claude') ||
      (usesInstance && (settings?.claudeCodeOauthCredentialsJson ?? '').trim().length > 0),
    codex: owns('codex') || (usesInstance && (settings?.codexAuthJson ?? '').trim().length > 0),
    // A person's own OpenCode provider replaces the instance one for them.
    openCode:
      ownOpenCode !== undefined
        ? (ownOpenCode.models ?? '').split('\n').filter(Boolean)
        : usesInstance
          ? instanceOpenCode
          : [],
  };
}

/** Who works in a shared project, by name, and which model each person's turns use. */
export function sharedProjectPeople(
  ctx: ServerContext,
  { availableModels }: { availableModels: AvailableModels },
) {
  const { deps } = ctx;
  /** Whether anyone besides the administrator may work in the project. */
  const sharedProject = async (projectId: string | null): Promise<boolean> =>
    projectId !== null &&
    (await deps.eventStore.listProjectUserIds(projectId, 'execute')).some(
      (userId) => userId !== legacyAdministratorId,
    );
  /**
   * The model `viewer`'s turns in a shared session run on (ADR 0023 §3): their
   * own choice in this session, else the session's model when their accounts
   * serve it, else their own project default, last model or first model.
   * Undefined outside shared projects, where the session's model applies as
   * before.
   */
  const personSessionModel = async (
    session: { sessionId: string; projectId: string | null; model: string },
    viewer: string,
  ): Promise<string | undefined> => {
    if (!(await sharedProject(session.projectId))) return undefined;
    const projectId = session.projectId!;
    const [available, settings] = await Promise.all([
      availableModels({ allowLegacyCodexFallback: true, viewer }),
      projectSettingsStore(deps.eventStore).getProjectSettings(projectId),
    ]);
    const usable = (model: string): boolean =>
      available.models.includes(model) &&
      isProjectSessionModel(model) &&
      isModelAllowedForProject(model, settings);
    const preferences = deps.eventStore.userProviderConnections;
    return preselectModel(
      [
        await preferences.sessionModel(session.sessionId, viewer),
        session.model,
        await preferences.projectDefaultModel(viewer, projectId),
        await preferences.lastModel(viewer, projectId),
        available.default ?? null,
      ],
      usable,
    );
  };
  /**
   * Who may work in a shared project, by name: what the app labels each person's
   * messages with. Undefined in a project only one person works in, whose
   * transcript stays unlabelled.
   */
  const projectPeopleNames = async (
    projectId: string | null,
  ): Promise<Record<string, string> | undefined> => {
    if (!(await sharedProject(projectId))) return undefined;
    const ids = [
      ...new Set([
        legacyAdministratorId,
        ...(await deps.eventStore.listProjectUserIds(projectId!, 'read')),
      ]),
    ];
    const chosen = await deps.eventStore.userDisplayNames(ids);
    const names: Record<string, string> = {};
    for (const id of ids) {
      const author =
        chosen.get(id) ?? (await deps.eventStore.userGitIdentities.author(id))?.authorName;
      names[id] = author?.trim() || (id === legacyAdministratorId ? 'Administrator' : 'Member');
    }
    return names;
  };
  /**
   * In a shared project a model switch is the person's own: it changes the model
   * their turns run on, without interrupting anyone else's. Answers false
   * elsewhere, where the session-wide switch applies.
   */
  const choosePersonModel = async (
    session: { sessionId: string; projectId: string | null },
    viewer: string,
    model: string,
  ): Promise<boolean> => {
    if (!(await sharedProject(session.projectId))) return false;
    const preferences = deps.eventStore.userProviderConnections;
    await preferences.setSessionModel(session.sessionId, viewer, model);
    await preferences.setLastModel(viewer, session.projectId!, model);
    return true;
  };
  /** Why `viewer` may not choose `model` as their own in a shared session. */
  const personalModelRefusal = async (
    session: { projectId: string | null },
    viewer: string,
    model: string,
  ): Promise<string | undefined> =>
    (await sharedProject(session.projectId))
      ? personModelRefusal(deps.eventStore, session.projectId!, viewer, model)
      : undefined;
  return {
    sharedProject,
    personSessionModel,
    projectPeopleNames,
    choosePersonModel,
    personalModelRefusal,
  };
}

/** Direct model queries on the accounts of the person the work is for. */
export function peopleDirectQueries(ctx: ServerContext, availableModels: AvailableModels) {
  const { deps } = ctx;
  /**
   * A direct model query on the accounts of the person the work is for (ADR 0023
   * §3): their own Codex login through the gateway and their own OpenCode
   * provider; the instance logins only for the administrator they belonged to,
   * and for work with no person behind it.
   */
  const directQueryFor = (userId: string | undefined) => {
    const instance = userId === undefined || userId === legacyAdministratorId;
    return createLiveMeetingAnalysisQuery({
      codexCredential: instance
        ? deps.codexGatewayCredentialProvider
        : deps.codexGatewayCredentialFor?.(userId),
      codexDefaultModel: async () =>
        (await availableModels({ viewer: userId })).modelOrder?.find(
          (id) => id.startsWith('codex/') && id !== CODEX_DEFAULT_MODEL,
        ),
      openCode: async () => {
        if (userId !== undefined) {
          const own = await deps.eventStore.userProviderConnections.get(userId, 'opencode');
          const baseUrl = own?.baseUrl?.trim();
          if (own !== undefined && baseUrl) return { baseUrl, apiKey: own.credential };
        }
        if (!instance) return undefined;
        const settings = await veritySettingsStore(deps.eventStore).getVeritySettings();
        const baseUrl = settings?.opencodeBaseUrl?.trim();
        const apiKey = settings?.opencodeApiKey?.trim();
        return baseUrl && apiKey ? { baseUrl, apiKey } : undefined;
      },
    });
  };
  /** Whether background work for `userId` may take the Claude path, which runs on
   *  the instance login: only the administrator's or work without a person. */
  const instanceClaudeServes = (userId: string | undefined): boolean =>
    userId === undefined || userId === legacyAdministratorId;
  return { directQueryFor, instanceClaudeServes };
}

/**
 * The routes of a person's own settings (ADR 0023 §3): profile, git identity and
 * signing key, AI provider accounts, Doppler and GitHub, and a project's team.
 */
export function installPeople(
  ctx: ServerContext,
  {
    agentLogin,
    persistPersonal,
    administratorAccounts,
  }: {
    agentLogin: AgentLoginService;
    administratorAccounts: ReturnType<typeof administratorProviderConnections>;
    persistPersonal: (
      userId: string,
      provider: ProviderConnectionKind,
      write: () => Promise<void>,
    ) => Promise<void>;
  },
): void {
  const { app, deps, conductor } = ctx;
  registerUserProfileRoutes(app, deps.eventStore.userProfiles);
  const gitIdentityDeps = {
    store: deps.eventStore,
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.sshKeygen !== undefined ? { sshKeygen: deps.sshKeygen } : {}),
  };
  registerGitIdentityRoutes(app, gitIdentityDeps);
  registerProviderConnectionRoutes(app, {
    store: deps.eventStore,
    agentLogin,
    administratorAccounts,
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    listOpenCodeModels: (baseUrl, apiKey) => fetchOpenCodeModels(baseUrl, apiKey),
    persist: persistPersonal,
  });
  const revokeMember = createMemberRevocation({
    store: deps.eventStore,
    dequeue: (sessionId, id) => conductor.dequeue(sessionId, id),
    cancelTurn: (sessionId) => conductor.cancelTurn(sessionId),
    sleepSandbox: deps.provisioner?.sleepPersonalSandbox?.bind(deps.provisioner),
    stopDevServers: (projectId, userId) =>
      deps.managedDevServerManager?.stopForPerson(projectId, userId) ?? Promise.resolve(),
    turnCredentials: deps.turnCredentials,
    signingCapabilities: deps.signingCapabilities,
    ghTokenCapabilities: deps.ghTokenCapabilities,
    claudeEgressIdentity: deps.claudeEgressIdentity,
    onError: (step, error) =>
      app.log.warn({ err: error, step }, "verity: ending a removed member's access was incomplete"),
  });
  registerTeamJoinRoutes(app, { store: deps.eventStore, authRegistry: deps.authRegistry });
  registerProjectTeamRoutes(app, {
    store: deps.eventStore,
    projectName: async (projectId) =>
      (await deps.eventStore.getProject(projectId))?.name ?? undefined,
    ...(deps.teamLinkIdentity === undefined ? {} : { linkIdentity: deps.teamLinkIdentity }),
    ...(deps.teamSharing === undefined ? {} : { teamSharing: deps.teamSharing }),
    onMemberRemoved: async (projectId, userId) => {
      await revokeMember(projectId, userId);
      await deps.onMemberRemoved?.(projectId, userId);
    },
  });
  registerDopplerConnectionRoutes(app, {
    store: deps.eventStore,
    listNames: (input) => listDopplerProjectSecretNames(input),
  });
  registerGitHubUserRoutes(app, {
    authorization:
      deps.githubUserAuthorization ?? createGitHubUserAuthorization({ store: deps.eventStore }),
    store: deps.eventStore,
    // Connecting GitHub is when a person's commits can first become verified:
    // give them a signing key of their own unless they already have one.
    onConnected: async (userId) => {
      if ((await deps.eventStore.userGitIdentities.publicIdentity(userId)).hasSigningKey) return;
      await mintPersonalSigningKey(gitIdentityDeps, userId);
    },
  });
}
