import type { Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';
import { isLocalProject } from '@verity/store';
import { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDocumentWorkspaceProvisioner,
  DOCUMENT_SESSION_DIRECTORY,
  documentWorkspace,
  isDocumentWorkspace,
} from './document-workspace.js';
import './fastify-augmentation.js';
import { LiveHub } from './live/live-hub.js';
import { containerPathFor } from './project-backend.js';
import { projectClonePath } from './provisioner.js';
import type { ServerDeps } from './server-deps.js';
import type { ProjectSettingsStore } from './server-types.js';
import {
  captureMoveSnapshot,
  moveGit,
  SessionMoveError,
  transferMoveSnapshot,
} from './session-move-files.js';
import { registerSessionMoveRoute } from './session-move-route.js';
import { createGitWorktreeProvisioner } from './worktree.js';

export function registerServerSessionMove({
  app,
  deps,
  conductor,
  hasMeetingJob,
  projectsBeingDeleted,
  beginProjectSpawn,
  liveHub,
  projectSettingsStore,
  invalidateBranchCache,
}: {
  app: FastifyInstance;
  deps: ServerDeps;
  conductor: Conductor;
  hasMeetingJob: (sessionId: string) => boolean;
  projectsBeingDeleted: ReadonlySet<string>;
  beginProjectSpawn: (projectId: string) => () => void;
  liveHub: LiveHub;
  projectSettingsStore: (store: EventStore) => ProjectSettingsStore;
  invalidateBranchCache: (worktree: string) => void;
}) {
  const beginPreviewSessionMove = async (projectId: string): Promise<() => void> => {
    const releasePublic = await deps.previewShareManager?.beginSessionMove(projectId);
    try {
      const releaseLocal = await deps.localPreviewManager?.beginSessionMove(projectId);
      return () => {
        releaseLocal?.();
        releasePublic?.();
      };
    } catch (error) {
      releasePublic?.();
      throw error;
    }
  };

  const recoverMovePreviews = async (sessionId: string, operationId: string): Promise<void> => {
    const move = await deps.eventStore.getSessionMove(sessionId, operationId);
    if (!move?.preview_restart_json) return;
    // Legacy configured Dev Servers are no longer restored during a move.
    await deps.eventStore.setMovePreviewRestart(sessionId, operationId, null);
  };

  app.addHook('onReady', async () => {
    for (const move of await deps.eventStore.listMovePreviewRestarts()) {
      let release: (() => void) | undefined;
      try {
        release = await beginPreviewSessionMove(move.source_project_id);
        await recoverMovePreviews(move.session_id, move.operation_id);
      } catch (error) {
        app.log.warn(
          { err: error, operationId: move.operation_id },
          'verity: move preview restart remains pending',
        );
      } finally {
        release?.();
      }
    }
    if (deps.projectCloneRoot)
      for (const move of await deps.eventStore.listPreparedSessionMoves()) {
        const target = await deps.eventStore.getProject(move.target_project_id);
        if (!target || !/^move-[0-9a-f]{64}$/.test(move.branch)) continue;
        const clone = projectClonePath(deps.projectCloneRoot, target);
        if (move.target_worktree !== join(clone, '.verity-sessions', move.branch)) continue;
        if ((await deps.eventStore.listSessionWorktrees()).includes(move.target_worktree)) continue;
        try {
          const exists = await lstat(move.target_worktree).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            },
          );
          if (exists)
            await moveGit(clone, 'worktree', 'remove', '--force', '--force', move.target_worktree);
          // A crash can occur between worktree creation and the first copied file.
          await moveGit(clone, 'branch', '-D', move.branch).catch(() => undefined);
        } catch (error) {
          app.log.warn(
            { err: error, operationId: move.operation_id },
            'verity: prepared move cleanup needs retry',
          );
        }
      }
  });

  registerSessionMoveRoute(app, {
    move: async (id, body) => {
      let session = await deps.eventStore.getSession(id);
      if (!session) throw new SessionMoveError('not_found', 'Session not found.', 404);
      const prior = await deps.eventStore.getSessionMove(id, body.operationId);
      if (
        prior &&
        (prior.target_project_id !== body.project || prior.on_commits !== body.onCommits)
      )
        throw new SessionMoveError(
          'operation_conflict',
          'This retry key belongs to a different move.',
        );
      if (prior?.result_json) {
        const release = await beginPreviewSessionMove(prior.source_project_id);
        try {
          await recoverMovePreviews(id, body.operationId);
        } finally {
          release?.();
        }
        return JSON.parse(prior.result_json) as unknown;
      }

      if (session.projectId && deps.provisioner?.prepareLocalDocuments) {
        await deps.provisioner.prepareLocalDocuments(session.projectId);
        session = await deps.eventStore.getSession(id);
        if (!session) throw new SessionMoveError('not_found', 'Session not found.', 404);
      }
      if (session.projectId === null || session.projectId === body.project)
        throw new SessionMoveError(
          'unsupported_session',
          'Choose a different local project for a normal project session.',
        );
      const source = await deps.eventStore.getProject(session.projectId);
      const target = await deps.eventStore.getProject(body.project);
      if (
        !source ||
        !target ||
        !isLocalProject(source) ||
        !isLocalProject(target) ||
        source.hiddenAt ||
        target.hiddenAt
      )
        throw new SessionMoveError(
          'unsupported_project',
          'Both projects must be visible local projects.',
        );
      if (hasMeetingJob(id))
        throw new SessionMoveError('busy', 'Finish the meeting job before moving.');
      const cloneRoot = deps.projectCloneRoot;
      const mutation = deps.provisioner?.withProjectExclusiveMutation?.bind(deps.provisioner);
      if (!cloneRoot || !mutation)
        throw new SessionMoveError('unavailable', 'Project lifecycle coordination is unavailable.');
      const projectIds = [source.id, target.id].sort();
      if (projectIds.some((projectId) => projectsBeingDeleted.has(projectId)))
        throw new SessionMoveError('busy', 'A project is being deleted.');
      if (deps.dataRoot && !isDocumentWorkspace(session.worktree))
        throw new SessionMoveError(
          'unsupported_session',
          'Migrate this legacy repository session to Documents before moving it to a document project.',
        );
      await deps.provisioner?.prepareLocalDocuments?.(target.id);
      const releases = projectIds.map(beginProjectSpawn);
      try {
        return await mutation(projectIds[0]!, () =>
          mutation(projectIds[1]!, async () => {
            const claim = await conductor.tryMoveSession(id, async () => {
              const duplicate = await deps.eventStore.getSessionMove(id, body.operationId);
              if (
                duplicate &&
                (duplicate.target_project_id !== body.project ||
                  duplicate.on_commits !== body.onCommits)
              )
                throw new SessionMoveError(
                  'operation_conflict',
                  'This retry key belongs to a different move.',
                );
              if (duplicate?.result_json) return JSON.parse(duplicate.result_json) as unknown;
              const releasePreview = await beginPreviewSessionMove(source.id);
              try {
                await recoverMovePreviews(id, body.operationId);
                if (isDocumentWorkspace(session.worktree)) {
                  if (!deps.dataRoot)
                    throw new SessionMoveError('unavailable', 'Document storage is unavailable.');
                  const targetClone = projectClonePath(cloneRoot, target);
                  const branch = `document-move-${createHash('sha256')
                    .update(JSON.stringify([id, body.operationId]))
                    .digest('hex')}`;
                  const targetWorktree = join(targetClone, DOCUMENT_SESSION_DIRECTORY, branch);
                  if (!duplicate) {
                    await deps.eventStore.prepareSessionMove({
                      sessionId: id,
                      operationId: body.operationId,
                      sourceProjectId: source.id,
                      sourceWorktree: session.worktree,
                      targetProjectId: target.id,
                      targetWorktree,
                      branch,
                      onCommits: body.onCommits,
                    });
                    await createDocumentWorkspaceProvisioner(
                      deps.dataRoot,
                      target.id,
                      targetClone,
                    ).add(branch);
                  } else if (
                    duplicate.target_worktree !== targetWorktree ||
                    duplicate.source_worktree !== session.worktree
                  ) {
                    throw new SessionMoveError(
                      'operation_conflict',
                      'The session changed since this move was prepared.',
                    );
                  }
                  const destination = documentWorkspace(deps.dataRoot, target.id, targetWorktree);
                  await destination.prepare();
                  const transferred = await documentWorkspace(
                    deps.dataRoot,
                    source.id,
                    session.worktree,
                  ).transferPending(destination, `Transferred edits/${body.operationId}`);
                  await destination.publish();
                  conductor.closeSession?.(id);
                  for (const binding of await deps.eventStore.getSessionBackendStates(id))
                    conductor.closeSession?.(binding.backendSessionId);
                  await deps.previewShareManager?.revokeSessionShares(source.id, id);
                  await deps.managedDevServerManager?.stopSession(id, { forget: true });
                  await deps.localPreviewManager?.stopSession(id);
                  const result = {
                    projectId: target.id,
                    worktree: targetWorktree,
                    branch: null,
                    contextMode: 'history-handoff',
                    transferred,
                    retainedWorktree: session.worktree,
                    retainedBranch: null,
                    skipped: [],
                  };
                  const notice = `This session moved to project ${target.id}, a Documents workspace without Git. Published source documents remain in the source project. Outstanding edits were copied under Transferred edits/${body.operationId}. Historical paths refer to the previous project. Use the target project's instructions and permissions.`;
                  await deps.eventStore.commitSessionMove(
                    id,
                    body.operationId,
                    notice,
                    JSON.stringify(result),
                  );
                  await liveHub.recheckSession(id);
                  return result;
                }
                const snapshot = await captureMoveSnapshot(session.worktree);
                const sourceSettings = await projectSettingsStore(
                  deps.eventStore,
                ).getProjectSettings(source.id);
                const sourceBase = sourceSettings?.defaultBranch ?? 'main';
                const commits = Number(
                  (await moveGit(session.worktree, 'rev-list', '--count', `${sourceBase}..HEAD`))
                    .toString()
                    .trim(),
                );
                if (commits > 0 && body.onCommits !== 'leave')
                  throw new SessionMoveError(
                    'source_commits',
                    `${commits} commits will stay on ${snapshot.branch} in the source project. Confirm leaving them before moving.`,
                  );
                const targetClone = projectClonePath(cloneRoot, target);
                const branch = `move-${createHash('sha256')
                  .update(JSON.stringify([id, body.operationId]))
                  .digest('hex')}`;
                const targetWorktree = join(targetClone, '.verity-sessions', branch);
                const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(
                  target.id,
                );
                const moveWorktreeOptions = { baseBranch: settings?.defaultBranch ?? 'main' };
                const provisioner =
                  deps.projectWorktrees?.(target, targetClone, moveWorktreeOptions) ??
                  createGitWorktreeProvisioner({
                    repoDir: targetClone,
                    worktreeRoot: join(targetClone, '.verity-sessions'),
                    ...moveWorktreeOptions,
                  });
                if (!duplicate) {
                  const occupied = await lstat(targetWorktree).then(
                    () => true,
                    (error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return false;
                      throw error;
                    },
                  );
                  if (
                    occupied ||
                    (await moveGit(targetClone, 'branch', '--list', branch)).length > 0
                  )
                    throw new SessionMoveError(
                      'operation_conflict',
                      'The reserved destination already exists. Start a new move.',
                    );
                  await deps.eventStore.prepareSessionMove({
                    sessionId: id,
                    operationId: body.operationId,
                    sourceProjectId: source.id,
                    sourceWorktree: session.worktree,
                    targetProjectId: target.id,
                    targetWorktree,
                    branch,
                    onCommits: body.onCommits,
                  });
                } else {
                  if (
                    duplicate.source_worktree !== session.worktree ||
                    duplicate.target_worktree !== targetWorktree
                  )
                    throw new SessionMoveError(
                      'operation_conflict',
                      'The session changed since this move was prepared.',
                    );
                  if ((await deps.eventStore.listSessionWorktrees()).includes(targetWorktree))
                    throw new SessionMoveError(
                      'operation_conflict',
                      'The destination is already in use.',
                    );
                  // This destination was reserved before creation and has never been exposed as a session.
                  // `--force` twice: session worktrees are locked against pruning.
                  try {
                    await moveGit(
                      targetClone,
                      'worktree',
                      'remove',
                      '--force',
                      '--force',
                      targetWorktree,
                    );
                  } catch {
                    if (
                      await lstat(targetWorktree).then(
                        () => true,
                        (error: NodeJS.ErrnoException) => {
                          if (error.code === 'ENOENT') return false;
                          throw error;
                        },
                      )
                    )
                      throw new SessionMoveError(
                        'recovery_required',
                        'The prepared workspace needs recovery before retrying.',
                      );
                  }
                  try {
                    await moveGit(targetClone, 'branch', '-D', branch);
                  } catch {
                    /* The crash may predate branch creation. */
                  }
                }
                try {
                  const created = await provisioner.add(branch);
                  if (created !== targetWorktree) throw new Error('Unexpected move worktree path');
                  const transferred = await transferMoveSnapshot(snapshot, created);
                  if (
                    (await captureMoveSnapshot(session.worktree)).fingerprint !==
                    snapshot.fingerprint
                  )
                    throw new SessionMoveError(
                      'source_changed',
                      'Source files changed during the move. Retry after writers have stopped.',
                    );
                  conductor.closeSession?.(id);
                  for (const binding of await deps.eventStore.getSessionBackendStates(id))
                    conductor.closeSession?.(binding.backendSessionId);
                  const result = {
                    projectId: target.id,
                    worktree: created,
                    branch,
                    contextMode: 'history-handoff',
                    ...transferred,
                    skipped: snapshot.skipped,
                    retainedWorktree: session.worktree,
                    retainedBranch: snapshot.branch,
                  };
                  const notice =
                    `This session moved to project ${target.id}, workspace ${containerPathFor(created, targetClone)}, branch ${branch}. ` +
                    `Historical paths refer to the previous project. Uncommitted work was copied. ` +
                    `The old workspace ${session.worktree} and branch ${snapshot.branch} are retained. ` +
                    `Commits were not transferred. ${snapshot.skipped.length} skipped entries remain in the source workspace. Use the target project's instructions and permissions.`;
                  await deps.previewShareManager?.revokeSessionShares(source.id, id);
                  // The instances belong to the source project; forget them so their
                  // network ports do not stay reserved for a session that left.
                  try {
                    await deps.managedDevServerManager?.stopSession(id, { forget: true });
                  } catch (error) {
                    app.log.warn(
                      { err: error, sessionId: id },
                      'verity: could not stop managed dev servers before the move',
                    );
                  }
                  await deps.localPreviewManager?.stopSession(id);
                  await deps.eventStore.commitSessionMove(
                    id,
                    body.operationId,
                    notice,
                    JSON.stringify(result),
                  );
                  await liveHub.recheckSession(id);
                  invalidateBranchCache(session.worktree);
                  return result;
                } catch (error) {
                  // A failed transfer must not leave an unexposed workspace accumulating on disk.
                  // Re-read the durable result before cleanup: a commit may have succeeded even if its response failed.
                  try {
                    const prepared = await deps.eventStore.getSessionMove(id, body.operationId);
                    if (
                      prepared &&
                      prepared.result_json === null &&
                      !(await deps.eventStore.listSessionWorktrees()).includes(targetWorktree)
                    ) {
                      const exists = await lstat(targetWorktree).then(
                        () => true,
                        (statError: NodeJS.ErrnoException) => {
                          if (statError.code === 'ENOENT') return false;
                          throw statError;
                        },
                      );
                      if (exists)
                        await moveGit(
                          targetClone,
                          'worktree',
                          'remove',
                          '--force',
                          '--force',
                          targetWorktree,
                        );
                      if ((await moveGit(targetClone, 'branch', '--list', branch)).length > 0)
                        await moveGit(targetClone, 'branch', '-D', branch);
                    }
                  } catch (cleanupError) {
                    app.log.warn(
                      { err: cleanupError, sessionId: id },
                      'Failed to clean prepared move workspace',
                    );
                  }
                  throw error;
                }
              } finally {
                try {
                  await recoverMovePreviews(id, body.operationId);
                } finally {
                  releasePreview?.();
                }
              }
            });
            if (!claim.ran)
              throw new SessionMoveError('busy', 'Finish or stop the current turn before moving.');
            return claim.value;
          }),
        );
      } finally {
        for (const release of releases) release();
      }
    },
  });
}
