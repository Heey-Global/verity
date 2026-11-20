import type { FastifyInstance } from 'fastify';
import { SealedError } from '@verity/store';
import { createAutomationExecutor } from './automation-executor.js';
import { registerAutomationRoutes } from './automation-routes.js';
import { startAutomationScheduler } from './automation-scheduler.js';
import { containerPathFor } from './project-backend.js';
import { projectClonePath } from './provisioner.js';
import type { ServerExecutionAuthority } from './server-authority.js';
import type { ServerContext } from './server-context.js';
import type { createServerModels } from './server-models.js';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';
import {
  emptyProjectSettings,
  PROJECT_MODEL_ERROR,
  ProjectNotReadyError,
  projectSettingsStore,
} from './server-support.js';

type ModelPolicy = Pick<
  ReturnType<typeof createServerModels>,
  'availableModels' | 'projectAgentRejection' | 'isConfiguredProjectSessionModel'
>;

interface AutomationOptions {
  canExecuteAs: ServerExecutionAuthority['canExecuteAs'];
  models: () => ModelPolicy;
}

interface AutomationRuntime {
  installRoutes: () => void;
}

export function createServerAutomations(
  app: FastifyInstance,
  ctx: ServerContext,
  { canExecuteAs, models }: AutomationOptions,
): AutomationRuntime {
  const { deps, lifecycle, conductor, sessionsBeingReaped } = ctx;
  // Model policy is wired later; resolve it only when a run or request needs it.
  const availableModels: ModelPolicy['availableModels'] = (...args) =>
    models().availableModels(...args);
  const projectAgentRejection: ModelPolicy['projectAgentRejection'] = (...args) =>
    models().projectAgentRejection(...args);
  const isConfiguredProjectSessionModel: ModelPolicy['isConfiguredProjectSessionModel'] = (
    ...args
  ) => models().isConfiguredProjectSessionModel(...args);
  // Session automations (ADR 0008): a recurring prompt bound to one ordinary
  // session. Prompt-only runs need nothing but the conductor, which wakes a
  // sleeping project for the turn itself; only a check script needs the
  // project container directly.
  const automationExecutor = createAutomationExecutor({
    isAuthorized: async (automation, session) => {
      try {
        return await canExecuteAs(automation.sponsorUserId, session.projectId);
      } catch {
        return false;
      }
    },
    isCurrent: async (automation, snapshot) => {
      const current = await deps.eventStore.getSessionAutomation(automation.sessionId);
      const session = await deps.eventStore.getSession(automation.sessionId);
      return (
        current?.id === automation.id &&
        current.status === 'enabled' &&
        current.sponsorUserId === (automation.sponsorUserId ?? null) &&
        session?.projectId === snapshot.projectId &&
        session.worktree === snapshot.worktree
      );
    },
    getSession: (sessionId) => deps.eventStore.getSession(sessionId),
    getProject: (projectId) => deps.eventStore.getProject(projectId),
    prepareProject: async (project) => {
      if (project.state === 'active') return project;
      if (
        (project.state === 'sleeping' || project.state === 'waking') &&
        deps.provisioner?.ensureProjectSandboxAwake
      ) {
        return deps.provisioner.ensureProjectSandboxAwake(project.id);
      }
      throw new ProjectNotReadyError();
    },
    beginProjectActivity: (projectId) => {
      if (deps.provisioner?.tryBeginProjectSandboxActivity?.(projectId) === false) return undefined;
      return () => deps.provisioner?.endProjectSandboxActivity?.(projectId);
    },
    ...(deps.projectRuntime?.runAutomationScript && deps.projectCloneRoot
      ? {
          runScript: async ({ script, project, session, automation }) => {
            const runtime = deps.projectRuntime;
            const cloneRoot = deps.projectCloneRoot;
            if (!runtime?.runAutomationScript || !cloneRoot) {
              throw new Error('Check scripts are not available on this server.');
            }
            const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(
              project.id,
            );
            try {
              if (!(await canExecuteAs(automation.sponsorUserId, project.id)))
                throw new Error('revoked');
            } catch {
              throw new ControlPlaneSessionAuthorityError(
                'The automation sponsor no longer has execution permission.',
              );
            }
            return runtime.runAutomationScript(
              project,
              settings ?? emptyProjectSettings(project.id),
              {
                workdir: containerPathFor(session.worktree, projectClonePath(cloneRoot, project)),
                script,
                timeoutMs: 120_000,
                maxOutputBytes: 64 * 1024,
              },
            );
          },
        }
      : {}),
    appendNotice: async (sessionId, text) => {
      await deps.eventStore.appendEvent(sessionId, { t: 'notice', text, role: 'agent' });
    },
    dispatchTurnWhenIdle: async (
      sessionId,
      prompt,
      { model, displayPrompt, validateSession, initiatedBy },
    ) =>
      // A run that fires while the session's project is being torn down would
      // start a turn against a worktree the purge is removing. Report it as not
      // accepted; by the next slot the session is gone or usable again.
      sessionsBeingReaped.has(sessionId)
        ? { accepted: false }
        : conductor.dispatchTurnWhenIdle(sessionId, prompt, model ? { model } : {}, {
            displayPrompt,
            validateSession,
            ...(initiatedBy ? { initiatedBy } : {}),
          }),
    isModelAllowed: async (model, session) =>
      session.projectId === null
        ? (await availableModels()).models.includes(model)
        : (await isConfiguredProjectSessionModel(model)) &&
          (await projectAgentRejection(model, session.projectId)) === undefined,
    // A sealed secret store or a project that is still being set up is not the
    // automation's fault; those slots are skipped rather than counted toward the
    // pause after repeated failures.
    isSkippableError: (error) =>
      error instanceof SealedError ||
      error instanceof ProjectNotReadyError ||
      error instanceof ControlPlaneSessionAuthorityError,
  });

  const automationScheduler = startAutomationScheduler({
    store: deps.eventStore,
    run: (automation) => automationExecutor.run(automation),
    log: app.log,
  });
  lifecycle.onClose(() => {
    automationScheduler.stop();
  });

  return {
    installRoutes: () => {
      registerAutomationRoutes(app, {
        eventStore: deps.eventStore,
        checkScript: (automation) => automationExecutor.checkScript(automation),
        // The same rules a turn's model must pass, checked once when the operator
        // confirms rather than on every unattended run.
        validateModel: async (model, session) => {
          if (session.projectId !== null) {
            if (!(await isConfiguredProjectSessionModel(model))) return PROJECT_MODEL_ERROR;
            return (await projectAgentRejection(model, session.projectId)) ?? null;
          }
          return (await availableModels()).models.includes(model)
            ? null
            : 'That model is not available on this server.';
        },
        onAutomationsChanged: () => automationScheduler.wake(),
      });
    },
  };
}
