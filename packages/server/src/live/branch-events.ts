import { domainTopic } from '@verity/events';
import type { SessionRecord } from '@verity/store';
import type { ServerContext } from '../server-context.js';
import { invalidatedBranches } from './invalidation-targets.js';
import { createRevisions } from './revisions.js';

/** How long invalidations of session branch lists gather into one
 * `branches.changed` each. Writes through the broker can arrive steadily
 * while an agent works; every event costs each device showing the session a
 * read, so a session announces at most one per window. */
export const BRANCHES_SETTLE_MS = 1_000;

/** How often the branch of an open session is read from git. A branch moved
 * by the agent or a switch in the app is seen at once; this bounds how long a
 * `git checkout` in the terminal takes to show. */
export const OPEN_SESSION_BRANCH_CHECK_MS = 10_000;

/**
 * Announces branch changes (ADR 0033). The session row, published as
 * `session.summary`, carries the branch; Home, the project page and the open
 * session apply it from there.
 *
 * Every git read of the session branch cache reports a branch other than the
 * last one announced for the worktree, whichever read it was: the agent's tool
 * activity, a switch in the app, a view's read. Its row is scheduled when
 * someone follows the session or its project; otherwise the next read of the
 * list shows the branch.
 *
 * Git run in the sandbox's terminal raises nothing the server sees, so the
 * branch of every session someone has open — its session topic subscribed —
 * is read again every {@link OPEN_SESSION_BRANCH_CHECK_MS}: one read per open
 * session, however many devices show it. These reads never wake a sleeping
 * sandbox, where nothing can change the branch.
 *
 * The branch list shows more than the branch: local commits not yet saved,
 * pull requests of the session's other repositories. What changes them —
 * tool activity, a merge or push through the routes, a pull request read that
 * finished — announces itself as an invalidation of the list; it reaches the
 * session topic as `branches.changed`, and the open session reads its list
 * again.
 *
 * Returns the handler the branch cache reports changed worktrees to.
 */
export function installBranchEvents(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: Pick<ServerContext, 'deps' | 'domainEvents' | 'lifecycle' | 'resources'>,
  refreshBranch: (session: SessionRecord) => Promise<void>,
  announce: (sessionId: string) => void,
  timers: {
    setInterval: (run: () => void, ms: number) => unknown;
    clearInterval: (timer: unknown) => void;
  } = {
    setInterval: (run, ms) => setInterval(run, ms).unref(),
    clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  },
): (worktree: string) => void {
  const { deps, domainEvents, lifecycle } = ctx;
  /** Sessions whose read still runs; a slow sandbox is not asked twice. */
  const checking = new Set<string>();
  let closed = false;

  const check = (): void => {
    for (const sessionId of domainEvents.watched('session')) {
      if (checking.has(sessionId)) continue;
      checking.add(sessionId);
      void deps.eventStore
        .getSession(sessionId)
        .then(
          (session) =>
            session === undefined || closed
              ? undefined
              : // A sandbox that is asleep or gone declines; the next check asks again.
                refreshBranch(session).catch(() => undefined),
          (error: unknown) => {
            app.log.warn({ err: error, sessionId }, 'verity: open session branch not checked');
          },
        )
        .finally(() => checking.delete(sessionId));
    }
  };

  const timer = timers.setInterval(check, OPEN_SESSION_BRANCH_CHECK_MS);

  const revisions = createRevisions();
  const invalidated = new Set<string>();
  let settle: ReturnType<typeof setTimeout> | undefined;
  const stopInvalidations = ctx.resources.onInvalidate((path) => {
    const sessionId = invalidatedBranches(path);
    if (sessionId === undefined || closed) return;
    invalidated.add(sessionId);
    if (settle !== undefined) return;
    settle = setTimeout(() => {
      settle = undefined;
      for (const id of invalidated) {
        domainEvents.publish(domainTopic('session', id), {
          t: 'branches.changed',
          sessionId: id,
          rev: revisions.next(),
        });
      }
      invalidated.clear();
    }, BRANCHES_SETTLE_MS);
    settle.unref();
  });

  lifecycle.onClose(() => {
    closed = true;
    timers.clearInterval(timer);
    stopInvalidations();
    if (settle !== undefined) clearTimeout(settle);
  });

  return (worktree) => {
    if (closed) return;
    void deps.eventStore
      .getSessionByWorktree(worktree)
      .then((session) => {
        if (session === undefined || closed) return;
        const followed =
          domainEvents.watching(domainTopic('session', session.sessionId)) ||
          (session.projectId !== null &&
            domainEvents.watching(domainTopic('project', session.projectId)));
        if (followed) announce(session.sessionId);
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error, worktree }, 'verity: branch change not announced');
      });
  };
}
