import { isLocalProject } from '@verity/store';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveProjectDefaultModel } from './project-agent-policy.js';
import { projectClonePath } from './provisioner.js';
import { ControlPlaneSessionToolError } from './session-handoff-tool.js';
import { createGitWorktreeProvisioner } from './worktree.js';
import type { ServerMcpRouteDeps } from './server-mcp-routes.js';

/**
 * Create the session a Control handoff starts in, once per idempotency key: a
 * repeated call with the same key while the first is still running gets its
 * result rather than a second session.
 */
export function createHandoffSessionCreator({
  deps,
  isControlPlaneProject,
  projectsBeingDeleted,
  beginProjectSpawn,
  projectSettingsStore,
  availableModels,
  isProjectSessionModel,
  isConfiguredProjectSessionModel,
  makeBranch,
  runningTurnInitiator,
}: Pick<
  ServerMcpRouteDeps,
  | 'deps'
  | 'isControlPlaneProject'
  | 'projectsBeingDeleted'
  | 'beginProjectSpawn'
  | 'projectSettingsStore'
  | 'availableModels'
  | 'isProjectSessionModel'
  | 'isConfiguredProjectSessionModel'
  | 'makeBranch'
  | 'runningTurnInitiator'
>) {
  const controlHandoffSessionCreates = new Map<string, Promise<{ sessionId: string }>>();
  return async ({
    projectId,
    name,
    idempotencyKey,
    caller,
  }: {
    projectId: string;
    name: string;
    idempotencyKey: string;
    caller?: { sessionId: string; turnId: string };
  }) => {
    const existing = controlHandoffSessionCreates.get(idempotencyKey);
    if (existing !== undefined) return existing;
    const creating = (async (): Promise<{ sessionId: string }> => {
      const digest = createHash('sha256').update(idempotencyKey).digest();
      digest[6] = (digest[6]! & 0x0f) | 0x40;
      digest[8] = (digest[8]! & 0x3f) | 0x80;
      const hex = digest.subarray(0, 16).toString('hex');
      const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const prior = await deps.eventStore.getSession(sessionId);
      if (prior !== undefined) {
        if (prior.projectId !== projectId) {
          throw new ControlPlaneSessionToolError('new-session handoff key collision');
        }
        return { sessionId };
      }
      const project = await deps.eventStore.getProject(projectId);
      if (
        project === undefined ||
        project.hiddenAt !== null ||
        (project.state !== 'active' &&
          project.state !== 'sleeping' &&
          project.state !== 'waking') ||
        isControlPlaneProject(project)
      ) {
        throw new ControlPlaneSessionToolError('new-session handoff target is unavailable');
      }
      if (deps.projectCloneRoot === undefined || deps.projectBackend === undefined) {
        throw new ControlPlaneSessionToolError('new-session handoff is not configured');
      }
      if (projectsBeingDeleted.has(project.id)) {
        throw new ControlPlaneSessionToolError('new-session handoff target is unavailable');
      }
      if (isLocalProject(project) && !deps.dataRoot)
        throw new ControlPlaneSessionToolError(
          'Local projects require configured document storage.',
        );
      // Host-side worktree creation is safe while asleep; the delivered turn wakes
      // the retained sandbox through the same preparation as a foreground message.
      await deps.provisioner?.prepareLocalDocuments?.(project.id);
      const releaseSpawn = beginProjectSpawn(project.id);
      try {
        const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(project.id);
        const model = resolveProjectDefaultModel(
          await availableModels({ allowLegacyCodexFallback: true }),
          settings,
          isProjectSessionModel,
        );
        if (model === undefined || !(await isConfiguredProjectSessionModel(model))) {
          throw new ControlPlaneSessionToolError('project has no eligible default model');
        }
        const selectedModel = model;
        const projectClone = projectClonePath(deps.projectCloneRoot, project);
        const worktreeOpts = {
          refreshBase: true,
          ...(settings?.defaultBranch == null ? {} : { baseBranch: settings.defaultBranch }),
        };
        const provisioner =
          deps.projectWorktrees?.(project, projectClone, worktreeOpts) ??
          createGitWorktreeProvisioner({
            repoDir: projectClone,
            worktreeRoot: join(projectClone, '.verity-sessions'),
            ...worktreeOpts,
          });
        await deps.refreshProjectToken?.(project);
        // Attribution only addresses the session's requests; a failed lookup leaves
        // them with the project's creator instead of failing the handoff.
        const createdByUserId = caller
          ? ((
              await Promise.resolve()
                .then(() => runningTurnInitiator(caller.sessionId, caller.turnId))
                .catch(() => undefined)
            )?.userId ?? null)
          : null;
        const worktree = await provisioner.add(makeBranch(name));
        try {
          await deps.eventStore.createSession({
            sessionId,
            projectId: project.id,
            worktree,
            model: selectedModel,
            name,
            createdByUserId,
          });
        } catch (error) {
          await provisioner.remove(worktree).catch(() => undefined);
          throw error;
        }
        return { sessionId };
      } finally {
        releaseSpawn();
      }
    })();
    controlHandoffSessionCreates.set(idempotencyKey, creating);
    try {
      return await creating;
    } finally {
      controlHandoffSessionCreates.delete(idempotencyKey);
    }
  };
}
