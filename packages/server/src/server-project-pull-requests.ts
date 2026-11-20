import type { registerSessionCreateRoute } from './session-create-route.js';
import { randomUUID } from 'node:crypto';
import {
  registerProjectPullRequestRoutes,
  type SessionPullRequestLink,
} from './project-pull-requests.js';
import type { ServerContext } from './server-context.js';
import type { createServerSessionOverview } from './server-session-overview.js';

/**
 * A project's pull requests: list them, and open a session that fixes one, at
 * most one per pull request at a time.
 */
export function installProjectPullRequests(
  ctx: ServerContext,
  {
    sessionCreate,
    sessionPrCache,
  }: {
    sessionCreate: ReturnType<typeof registerSessionCreateRoute>;
    sessionPrCache: ReturnType<typeof createServerSessionOverview>['sessionPrCache'];
  },
): void {
  const { app, deps, conductor } = ctx;
  const pullRequestFixes = new Map<string, Promise<{ sessionId: string; created: boolean }>>();
  registerProjectPullRequestRoutes(app, {
    store: deps.eventStore,
    backend: deps.projectPullRequests,
    sessionLinks: async (projectId) => {
      const sessions = (await deps.eventStore.listSessions()).filter(
        (session) => session.projectId === projectId,
      );
      // One lookup per session, read together rather than one after another.
      const workspaces = await Promise.all(
        sessions.map((session) =>
          deps.eventStore.listSessionRepositoryWorkspaces(session.sessionId),
        ),
      );
      return sessions.flatMap((session, index): SessionPullRequestLink[] => {
        // Only what is already known: the project page reads every session's PR
        // status, so asking the code host again here would double that traffic.
        const pr = sessionPrCache.peek(session.worktree);
        return [
          {
            sessionId: session.sessionId,
            repositoryId: `default:${projectId}`,
            ...(pr ? { number: pr.number } : {}),
            name: session.name,
          },
          ...workspaces[index]!.map((workspace): SessionPullRequestLink => {
            const number = (workspace.pullRequest as { number?: unknown } | null | undefined)
              ?.number;
            return {
              sessionId: session.sessionId,
              repositoryId: workspace.repositoryId,
              branch: workspace.branch,
              ...(typeof number === 'number' ? { number } : {}),
              name: session.name,
            };
          }),
        ];
      });
    },
    startFix: (input) => {
      const key = `${input.project.id}\u0000${input.resource}`;
      const running = pullRequestFixes.get(key);
      if (running) return running;
      const start = async () => {
        const repairs = deps.eventStore.repairs;
        const existing = await repairs.sessionOrigin(input.project.id, input.resource);
        if (existing && (await deps.eventStore.getSession(existing)))
          return { sessionId: existing, created: false };
        const sessionId = randomUUID();
        const spawned = await sessionCreate.spawn(
          {
            projectId: input.project.id,
            sessionId,
            name: `Fix PR #${String(input.status.number)}`,
          },
          app.log,
        );
        if (spawned.statusCode >= 300)
          throw Object.assign(new Error('The fix session could not be created'), {
            statusCode: spawned.statusCode >= 500 ? 503 : spawned.statusCode,
          });
        // A session that never got its prompt, or lost the claim to another
        // process, is removed again: a durable origin pointing at it would turn
        // every later tap into "already fixing", and a duplicate helps no one.
        const discard = () =>
          ctx.deleteSession(sessionId).catch((error: unknown) => {
            app.log.warn({ err: error, sessionId }, 'could not remove an unused fix session');
            return false;
          });
        try {
          const owner = existing
            ? await repairs.replaceSessionOrigin(
                input.project.id,
                input.resource,
                existing,
                sessionId,
              )
            : await repairs.registerSessionOrigin(input.project.id, input.resource, sessionId);
          if (owner === undefined)
            throw Object.assign(new Error('The fix session could not be recorded'), {
              statusCode: 503,
            });
          if (owner !== sessionId) {
            await discard();
            return { sessionId: owner, created: false };
          }
          await conductor.dispatchTurn(sessionId, input.prompt, undefined, {
            displayPrompt: `Fix pull request #${String(input.status.number)}`,
            ...(input.userId ? { initiatedBy: { userId: input.userId } } : {}),
          });
        } catch (error) {
          // The origin, if recorded, now names a missing session; the next tap
          // replaces it.
          await discard();
          if (typeof (error as { statusCode?: unknown }).statusCode === 'number') throw error;
          app.log.error({ err: error, sessionId }, 'fix session could not be started');
          throw Object.assign(new Error('The fix session could not be started. Try again.'), {
            statusCode: 503,
          });
        }
        return { sessionId, created: true };
      };
      const promise = start().finally(() => pullRequestFixes.delete(key));
      pullRequestFixes.set(key, promise);
      return promise;
    },
  });
}
