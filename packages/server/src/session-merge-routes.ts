import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendExternalPromptData } from '@verity/events';
import type { Conductor } from '@verity/session';
import type { ProjectRecord, SessionRecord } from '@verity/store';
import type { ServerDeps } from './server.js';
import type { PullRequestStatus } from './github.js';
import {
  BaseCheckoutStrandedError,
  BaseCheckoutUnavailableError,
  BranchNotFoundError,
  DirtyWorktreeError,
  InvalidBranchNameError,
  MergeConflictError,
  NothingToMergeError,
  type GitBranchService,
  type GitOutput,
} from './branches.js';
import { SandboxUnavailableError } from './sandbox-git.js';
import { sessionParams } from './session-route-schemas.js';
import { transferSessionCommit } from './session-git-transfer.js';

type PrSummary = Pick<PullRequestStatus, 'phase' | 'pipeline' | 'mergeable'>;
export interface SessionMergeRouteDeps {
  eventStore: ServerDeps['eventStore'];
  mergePr: ServerDeps['mergePr'];
  provisioner: ServerDeps['provisioner'];
  branchPrStatus: ServerDeps['branchPrStatus'];
  branchPrStatusForBranches: ServerDeps['branchPrStatusForBranches'];
  sandboxGit: ServerDeps['sandboxGit'];
  sessionSandboxGit?: (
    sessionId: string,
    project: ProjectRecord,
    worktree: string,
  ) => Promise<GitOutput>;
  conductor: Pick<
    Conductor,
    'dispatchTurn' | 'runWhenIdle' | 'emitMerged' | 'tryRunExclusive' | 'runExclusive'
  >;
  branchesForSession: (session: SessionRecord) => Promise<GitBranchService | undefined>;
  localMergeTarget: (
    session: SessionRecord,
  ) => Promise<{ basePath: string; project: ProjectRecord } | undefined>;
  sessionPrStatus: (session: SessionRecord) => Promise<PullRequestStatus | null>;
  compactPr: (status: PullRequestStatus | null) => PrSummary | null;
  applyPrSummaryAction: (session: SessionRecord, summary: PrSummary | null) => void;
  invalidatePrSummaryAction: (session: SessionRecord) => void;
}

const mergePullRequestBody = z.object({
  number: z.number().int().positive(),
});

function buildLocalMergeDisplayPrompt(): string {
  // This durable transcript text may later be replayed as a model prompt. Keep
  // Git-controlled ref names out of the operator-authored prompt channel.
  return 'Saved to project';
}

function buildLocalMergedPrompt(branch: string, base: string, note: string): string {
  return appendExternalPromptData(
    'A local merge completed. Please continue from this post-merge state.',
    'local Git metadata and merge result',
    { branch, base, note },
  );
}

function buildPullRequestMergeRejectedDisplayPrompt(number: number): string {
  return `Fix merge for PR #${String(number)}`;
}

function buildPullRequestMergeRejectedPrompt(number: number): string {
  return `${buildPullRequestMergeRejectedDisplayPrompt(number)}

GitHub rejected the merge for pull request #${String(number)}. Please inspect why the PR cannot be merged, fix any failing CI/checks or merge conflicts, update the branch, run the relevant verification, and report the result.`;
}

export function registerSessionMergeRoutes(
  app: FastifyInstance,
  deps: SessionMergeRouteDeps,
): {
  mergeLocalSession: (
    id: string,
    setStatus: (status: number) => void,
    approvedTip?: string,
  ) => Promise<{ merged: true; base: string; branch: string } | { error: string }>;
} {
  const {
    conductor,
    branchesForSession,
    localMergeTarget,
    sessionPrStatus,
    compactPr,
    applyPrSummaryAction,
    invalidatePrSummaryAction,
  } = deps;
  app.post(
    '/sessions/:id/pull-request/merge',
    async (request, reply): Promise<{ merged: true } | { error: string }> => {
      const { id } = sessionParams.parse(request.params);
      const { number } = mergePullRequestBody.parse(request.body);
      if (!deps.mergePr) {
        reply.code(503);
        return { error: 'pull request merging is not configured' };
      }
      const session = await deps.eventStore.getSession(id);
      if (!session) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      const syncProjectCheckout = async (): Promise<boolean> => {
        if (session.projectId === null || !deps.provisioner?.syncProjectCheckout) return true;
        try {
          // Refresh the managed default-branch checkout used by dev servers that
          // are not previewing a session.
          await deps.provisioner.syncProjectCheckout(session.projectId);
          return true;
        } catch (error) {
          // A remote merge cannot be rolled back. Callers keep the merge response
          // successful and surface the local follow-up failure where possible.
          app.log.error(
            { err: error, projectId: session.projectId, pullRequest: number },
            'failed to synchronize project checkout after pull request merge',
          );
          return false;
        }
      };
      // The branch this PR merges INTO, for the post-merge worktree reset below.
      // Undefined when no resolver is injected — the reset then falls back to the
      // project's base branch, as it always did.
      let mergedBaseRef: string | undefined;
      // The push payload is a routing hint, never authorization. Re-resolve the
      // session's PR at action time so a forged/stale notification cannot merge an
      // arbitrary PR from the repository. Older injected deployments without a PR
      // status resolver retain the pre-existing merge behavior.
      if (deps.branchPrStatus !== undefined || deps.branchPrStatusForBranches !== undefined) {
        const current = await sessionPrStatus(session).catch(() => null);
        if (current?.number === number && current.phase === 'merged') {
          applyPrSummaryAction(session, compactPr(current));
          // Preserve idempotency while still repairing a checkout left stale by
          // an external merge or an earlier failed synchronization attempt.
          if (!(await syncProjectCheckout())) {
            const note = `Pull request #${String(number)} was already merged, but the project's managed default-branch checkout could not be refreshed automatically.`;
            await deps.eventStore.appendPendingNote(id, note).catch(() => undefined);
          }
          return { merged: true };
        }
        if (
          current?.number !== number ||
          current.phase !== 'open' ||
          current.pipeline !== 'success' ||
          current.mergeable !== true
        ) {
          applyPrSummaryAction(session, compactPr(current));
          reply.code(409);
          return { error: `pull request #${String(number)} is no longer ready to merge` };
        }
        // Read from the re-resolved PR, so it describes the pull request this
        // request is about to merge rather than whatever the push payload claimed.
        mergedBaseRef = current.baseRef;
      }
      const merged = await deps.mergePr(number, session.worktree).catch(() => false);
      if (!merged) {
        invalidatePrSummaryAction(session);
        await conductor
          .dispatchTurn(id, buildPullRequestMergeRejectedPrompt(number), undefined, {
            displayPrompt: buildPullRequestMergeRejectedDisplayPrompt(number),
          })
          .catch(() => undefined);
        reply.code(409);
        return { error: `pull request #${String(number)} could not be merged` };
      }
      applyPrSummaryAction(session, {
        phase: 'merged',
        pipeline: 'success',
        mergeable: false,
      });
      const projectCheckoutSyncFailed = !(await syncProjectCheckout());
      // Post-merge worktree housekeeping is deterministic and server-side: the reset
      // force-checks-out the worktree, so it must never run under a live turn. The
      // transcript marker and pending agent note are written only after the cleanup
      // attempt, so the next real turn sees the final post-merge state.
      await conductor
        .runWhenIdle(id, async () => {
          let note = `Pull request #${String(number)} was merged.`;
          const branches = await branchesForSession(session);
          if (branches) {
            try {
              // Against the branch the PR merged into, not the project's base: a
              // stacked PR targets another session's branch, and resetting to the
              // project base would force-check-out a commit without the merged work.
              //
              // Re-resolved now that the merge has landed, because a base retargeted
              // between the pre-merge check and the merge itself would leave the
              // earlier answer describing a branch this PR did not merge into. This
              // reads GitHub rather than the pre-merge row because a successful merge
              // drops the PR service's per-branch cache (`github.ts`); without that it
              // would replay the very answer it is meant to re-check. The pre-merge
              // value stands in when the PR no longer resolves — GitHub deletes the
              // head branch this looks the PR up by.
              const settled = await sessionPrStatus(session).catch(() => null);
              const target =
                settled?.number === number && settled.phase === 'merged'
                  ? (settled.baseRef ?? mergedBaseRef)
                  : mergedBaseRef;
              const { base, deletedBranch } = await branches.resetToMergedBase(
                session.worktree,
                target === undefined ? {} : { base: target },
              );
              const deletedClause = deletedBranch
                ? ` and the merged local branch "${deletedBranch}" was deleted`
                : '';
              // Purely informational — the reset already happened; the agent is not
              // instructed to do anything (the detached HEAD is the server's doing).
              note = `Pull request #${String(number)} was merged and your worktree has been reset to ${base} (detached at the merged commit)${deletedClause}.`;
            } catch {
              // Housekeeping is non-atomic (fetch → detach → delete the merged branch):
              // on failure the worktree MAY already be reset (only the branch delete
              // failed) or not (the fetch/checkout failed). We can't tell which here, so
              // word it neutrally — never falsely claim the reset did or didn't happen.
              note = `Pull request #${String(number)} was merged, but the automatic worktree cleanup afterwards did not fully complete.`;
            }
          }
          if (projectCheckoutSyncFailed) {
            note +=
              " The project's managed default-branch checkout could not be refreshed automatically.";
          }
          // The merge and cleanup need no model reasoning. Keep the detail available
          // to the agent on its next genuine turn, while showing the user one concise
          // transcript marker now. Both are best-effort because the PR already landed.
          await deps.eventStore.appendPendingNote(id, note).catch(() => undefined);
          await conductor.emitMerged(id, number).catch(() => undefined);
        })
        .catch(() => undefined);
      return { merged: true };
    },
  );

  // Merge a session branch into its project's base branch WITHOUT GitHub — the
  // counterpart of the pull-request merge above for `local` projects, which have no
  // remote to open a PR against. Restricted to those projects on purpose: anything
  // with a GitHub repository keeps the PR (and its review + CI gate) as the single
  // way work reaches the base branch. Error mapping: 409 busy / not a local project /
  // dirty / conflicting / nothing to merge, 404 unknown session, 503 unconfigured.
  const mergeLocalSession = async (
    id: string,
    setStatus: (status: number) => void,
    approvedTip?: string,
  ): Promise<{ merged: true; base: string; branch: string } | { error: string }> => {
    const session = await deps.eventStore.getSession(id);
    if (!session) {
      setStatus(404);
      return { error: `session ${id} not found` };
    }
    const branches = await branchesForSession(session);
    if (!branches) {
      setStatus(503);
      return { error: 'merging is not configured' };
    }
    const target = await localMergeTarget(session);
    if (target === undefined) {
      setStatus(409);
      return { error: 'this project merges through its pull request' };
    }
    const { basePath, project } = target;
    // Every git command below runs in the project's own sandbox, not on the server:
    // the clone's `.git/config` belongs to the session, and config keys such as
    // `filter.<name>.clean` or `merge.<name>.driver` name a program git executes.
    // Without that seam there is nowhere safe to run the merge, so refuse it.
    const sandboxGit = deps.sandboxGit?.(project, basePath);
    if (sandboxGit === undefined) {
      setStatus(503);
      return { error: 'merging is not configured' };
    }
    const sessionGit = deps.sessionSandboxGit
      ? await deps.sessionSandboxGit(id, project, session.worktree)
      : sandboxGit;
    // Merging a branch a live turn is still writing to would land half-finished
    // work — same admission rule as the branch switch below. The turn lock is held
    // for the whole merge rather than only sampled first: a turn that started in
    // between could commit after the branch tip is read, so the operator would be
    // told work landed that did not.
    let merged: { base: string; branch: string; mergedTip: string; baseTip: string };
    try {
      const attempt = await conductor.tryRunExclusive(id, async () => {
        if (approvedTip !== undefined) {
          const currentTip = (
            await sessionGit(['-C', session.worktree, 'rev-parse', 'HEAD'])
          ).trim();
          if (currentTip !== approvedTip) return null;
        }
        if (!deps.sessionSandboxGit) {
          return branches.mergeIntoLocalBase(session.worktree, basePath, { git: sandboxGit });
        }
        const transfer = await transferSessionCommit({
          source: session.worktree,
          destination: basePath,
          sourceGit: sessionGit,
          destinationGit: sandboxGit,
        });
        try {
          return await branches.mergeIntoLocalBase(session.worktree, basePath, {
            git: sandboxGit,
            sessionGit,
            mergeRef: transfer.ref,
          });
        } finally {
          await transfer.cleanup();
        }
      });
      if (!attempt.ran) {
        setStatus(409);
        return { error: `session ${id} is busy — finish the turn before merging` };
      }
      if (attempt.value === null) {
        setStatus(409);
        return { error: 'the session changed after the agent approved it — save again' };
      }
      merged = attempt.value;
    } catch (error) {
      if (error instanceof DirtyWorktreeError) {
        setStatus(409);
        return { error: 'the worktree has uncommitted changes — commit or stash them first' };
      }
      if (error instanceof BaseCheckoutUnavailableError) {
        // Deliberately does not echo the error's host path.
        setStatus(409);
        return {
          error:
            "the project's base checkout is not ready to merge into — it is detached or has uncommitted changes",
        };
      }
      if (error instanceof BaseCheckoutStrandedError) {
        // The one failure here that does NOT leave the base as it was. Merging again
        // could compound it, so say what is wrong instead of offering a retry.
        setStatus(409);
        return {
          error: `merging "${error.branch}" failed and the project's base checkout could not be restored — it may be left mid-merge, so check the project before merging again`,
        };
      }
      if (error instanceof MergeConflictError) {
        setStatus(409);
        return {
          error: `"${error.branch}" conflicts with "${error.base}" — resolve the conflicts in this session, then merge again`,
        };
      }
      if (error instanceof NothingToMergeError) {
        setStatus(409);
        return { error: `"${error.base}" already contains this branch` };
      }
      if (error instanceof BranchNotFoundError) {
        setStatus(409);
        return { error: 'this session is not on a local branch' };
      }
      if (error instanceof InvalidBranchNameError) {
        setStatus(409);
        return {
          error:
            'this session or the project base is on a ref whose name git would misread — rename the branch, then merge again',
        };
      }
      if (error instanceof SandboxUnavailableError) {
        // The merge runs in the project's container, so a stopped project is a
        // precondition the operator can fix — not a repository problem. Deliberately
        // does not echo the container name.
        setStatus(409);
        return { error: 'this project is not running — start it, then merge again' };
      }
      throw error; // unexpected → error boundary → sanitized 500
    }
    const { base, branch } = merged;
    // The merge itself has landed; what follows is worktree housekeeping that
    // detaches HEAD and drops the merged branch, so it must never run beside a live
    // turn. Unlike the merge it does not have to happen now, so it waits for idle
    // instead of rejecting: `runExclusive` parks it behind any turn that drained
    // while the merge released the lock, then holds that lock for the whole reset.
    await conductor
      .runExclusive(id, async () => {
        // The merge is stated unconditionally — it definitely succeeded. Only the
        // housekeeping clause varies.
        const merge = `Your branch "${branch}" was merged into "${base}" in this project's local repository (it has no GitHub remote)`;
        let note: string;
        try {
          // The whole merge result: the branch commit it absorbed decides what may be
          // deleted, the merge commit it created is where the worktree lands.
          if (deps.sessionSandboxGit) {
            const transfer = await transferSessionCommit({
              source: basePath,
              destination: session.worktree,
              sourceGit: sandboxGit,
              destinationGit: sessionGit,
              commit: merged.baseTip,
            });
            await transfer.cleanup();
          }
          const { deletedBranch, retainedBranch, skipped } = await branches.resetToLocalBase(
            session.worktree,
            base,
            merged,
            { git: sessionGit },
          );
          if (skipped === true) {
            note = `${merge}, up to the commit it was on when you merged. Your worktree kept that branch because it has moved on since — commit or discard what is there and merge again to bring the rest across.`;
          } else if (retainedBranch !== undefined) {
            // Half-done on purpose: detached, branch kept. Say both, so the retained
            // commits are not mistaken for merged ones.
            note = `${merge}, up to the commit it was on when you merged. Your worktree is now detached at that merged commit, but the branch "${retainedBranch}" was kept because it has moved on since — merge again to bring the rest across.`;
          } else {
            const deletedClause = deletedBranch
              ? ` and the merged local branch "${deletedBranch}" was deleted`
              : '';
            note = `${merge}. Your worktree is now detached at the merged commit${deletedClause}.`;
          }
        } catch {
          // Non-atomic (detach → delete the branch): on failure the worktree MAY
          // already be detached or not, and we cannot tell which here. Word it so we
          // never falsely claim the cleanup did or didn't happen.
          note = `${merge}, but the automatic worktree cleanup afterwards did not fully complete.`;
        }
        // Dispatched while the lock is still held, so it enqueues and drains the
        // moment the reset releases it — never before the worktree is settled.
        await conductor
          .dispatchTurn(id, buildLocalMergedPrompt(branch, base, note), undefined, {
            displayPrompt: buildLocalMergeDisplayPrompt(),
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return { merged: true, base, branch };
  };

  app.post('/sessions/:id/merge', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    return mergeLocalSession(id, (status) => {
      reply.code(status);
    });
  });

  return { mergeLocalSession };
}
