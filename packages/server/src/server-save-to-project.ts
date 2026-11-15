import { appendExternalPromptData } from '@verity/events';
import { randomUUID } from 'node:crypto';
import { SandboxUnavailableError } from './sandbox-git.js';
import { sessionParams } from './session-route-schemas.js';
import type { ServerContext } from './server-context.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import type { registerSessionMergeRoutes } from './session-merge-routes.js';

type SessionOverview = ReturnType<typeof createServerSessionOverview>;

/**
 * `POST /sessions/:id/save-to-project`: merge a local session's branch into its
 * project, one save per session at a time and never while a turn runs.
 */
export function installSaveToProject(
  ctx: ServerContext,
  {
    branchesForSession,
    localMergeTarget,
    mergeLocalSession,
  }: {
    branchesForSession: SessionOverview['branchesForSession'];
    localMergeTarget: SessionOverview['localMergeTarget'];
    mergeLocalSession: ReturnType<typeof registerSessionMergeRoutes>['mergeLocalSession'];
  },
): void {
  const { app, deps, conductor } = ctx;
  const localSavesInFlight = new Set<string>();
  app.post('/sessions/:id/save-to-project', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const session = await deps.eventStore.getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    const target = await localMergeTarget(session);
    if (target === undefined) {
      reply.code(409);
      return { error: 'saving this way is available only for local projects' };
    }
    const sandboxGit = deps.sandboxGit?.(target.project, target.basePath);
    if (!(await branchesForSession(session)) || sandboxGit === undefined) {
      reply.code(503);
      return { error: 'saving to this project is not configured' };
    }
    if (localSavesInFlight.has(id) || conductor.isBusy(id)) {
      reply.code(409);
      return { error: 'finish the current session activity before saving to the project' };
    }

    localSavesInFlight.add(id);
    // The save and its follow-up turns run for the user who asked for it, so they keep
    // gateway tool access under authentication.
    const initiatedBy = request.localUserId ? { userId: request.localUserId } : undefined;
    const origin = initiatedBy ? { initiatedBy } : {};
    const approvalRef = `refs/verity/save-approval/${randomUUID()}`;
    const prompt =
      "Save this session's work to the local project. Review the working tree and the branch changes. " +
      'Run proportionate checks, then commit relevant uncommitted changes with a clear commit message. ' +
      'Do not include secrets, generated local state, or unrelated files. Do not push or merge: ' +
      'Verity will add the committed version to the project after this turn. ' +
      'If you cannot safely commit the work or checks fail, explain why and leave it unchanged. ' +
      `Only after all checks pass and the work is ready to add, run git update-ref ${approvalRef} HEAD as your final command. Do not create that ref when declining to save.`;
    void (async () => {
      try {
        const result = await conductor.sendTurn(id, prompt, {}, 'Save to project', origin);
        if (result.aborted || result.exitCode !== 0) return;
        let approvedTip: string;
        try {
          approvedTip = (
            await sandboxGit(['-C', session.worktree, 'rev-parse', '--verify', approvalRef])
          ).trim();
        } catch (error) {
          if (error instanceof SandboxUnavailableError) throw error;
          return;
        }
        await sandboxGit(['-C', session.worktree, 'update-ref', '-d', approvalRef]);
        if (approvedTip.length === 0) return;
        const branches = await branchesForSession(session);
        if (await branches?.isDirty(session.worktree)) {
          await conductor.dispatchTurn(
            id,
            'Saving to the local project stopped because some file changes are still uncommitted. Explain which changes need attention. Do not merge them.',
            undefined,
            { displayPrompt: 'Save to project needs attention', ...origin },
          );
          return;
        }
        const merged = await mergeLocalSession(id, () => undefined, approvedTip, initiatedBy);
        if ('error' in merged) {
          await conductor.dispatchTurn(
            id,
            appendExternalPromptData(
              'Saving to the local project could not finish. Explain what needs attention.',
              'local merge error',
              { error: merged.error },
            ),
            undefined,
            { displayPrompt: 'Save to project needs attention', ...origin },
          );
        }
      } catch (error) {
        app.log.error({ err: error, sessionId: id }, 'save to local project failed');
        await conductor
          .dispatchTurn(
            id,
            'Saving to the local project stopped unexpectedly. Explain that the work has not been added to the project and ask to retry once the session is ready.',
            undefined,
            { displayPrompt: 'Save to project needs attention', ...origin },
          )
          .catch(() => undefined);
      } finally {
        localSavesInFlight.delete(id);
      }
    })();
    reply.code(202);
    return { accepted: true };
  });
}
