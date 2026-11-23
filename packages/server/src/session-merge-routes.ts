import { ForgeMergePermissionError } from './forge-provider.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendExternalPromptData } from '@verity/events';
import type { Conductor } from '@verity/session';
import type { ProjectRecord, SessionRecord } from '@verity/store';
import type { ServerDeps } from './server-deps.js';
import type { PullRequestStatus } from './forge-provider.js';
import {
  BaseCheckoutStrandedError,
  BaseCheckoutUnavailableError,
  BranchNotFoundError,
  DirtyWorktreeError,
  InvalidBranchNameError,
  MergeConflictError,
  NothingToMergeError,
  type GitBranchService,
} from './branches.js';
import { SandboxUnavailableError } from './sandbox-git.js';
import type { createSessionRepositoryPullRequests } from './session-repository-pull-requests.js';
import { sessionParams } from './session-route-schemas.js';

type PrSummary = Pick<PullRequestStatus, 'phase' | 'pipeline' | 'mergeable'>;
export interface SessionMergeRouteDeps {
  eventStore: ServerDeps['eventStore'];
  mergePr: ServerDeps['mergePr'];
  projectPullRequests?: ServerDeps['projectPullRequests'];
  resolvePullRequests?: ReturnType<typeof createSessionRepositoryPullRequests>;
  invalidateBranchResource?: (sessionId: string) => void;
  provisioner: ServerDeps['provisioner'];
  branchPrStatus: ServerDeps['branchPrStatus'];
  branchPrStatusForBranches: ServerDeps['branchPrStatusForBranches'];
  sandboxGit: ServerDeps['sandboxGit'];
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
  beforePrCleanup?: (session: SessionRecord) => void;
  afterPrCleanup?: (session: SessionRecord, status: PullRequestStatus | null) => Promise<void>;
  invalidatePrSummaryAction: (session: SessionRecord) => void;
}

const mergePullRequestBody = z.object({
  number: z.number().int().positive(),
  repositoryId: z.string().min(1).optional(),
  // The commit the operator confirmed. When given, a branch that moved since
  // (for example a fix session pushing) is refused rather than merged unseen.
  expectedHeadSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/u)
    .optional(),
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

The forge rejected the merge for pull request #${String(number)}. Please inspect why the PR cannot be merged, fix any failing CI/checks or merge conflicts, update the branch, run the relevant verification, and report the result. Do not change repository permissions, branch protection, review requirements, or other security policies. If permission or policy prevents merging, stop and ask the user to have a maintainer merge it.`;
}

export function registerSessionMergeRoutes(
  app: FastifyInstance,
  deps: SessionMergeRouteDeps,
): {
  mergeLocalSession: (
    id: string,
    setStatus: (status: number) => void,
    approvedTip?: string,
    initiatedBy?: { userId: string },
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
    async (request, reply): Promise<{ merged: true } | { error: string; code?: string }> => {
      const { id } = sessionParams.parse(request.params);
      const { number, expectedHeadSha, repositoryId } = mergePullRequestBody.parse(request.body);
      if (repositoryId === undefined ? !deps.mergePr : !deps.projectPullRequests) {
        reply.code(503);
        return { error: 'pull request merging is not configured' };
      }
      const session = await deps.eventStore.getSession(id);
      if (!session) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      const defaultRepositoryId = `default:${session.projectId}`;
      const selectedRepositoryId =
        repositoryId ??
        (deps.projectPullRequests && session.projectId ? defaultRepositoryId : undefined);
      const findTarget = async (legacy?: PullRequestStatus | null) =>
        (
          await deps.resolvePullRequests?.(session, legacy, undefined, selectedRepositoryId, number)
        )?.find(
          (row) =>
            row.status.repository.id === selectedRepositoryId && row.status.number === number,
        );
      let target: Awaited<ReturnType<typeof findTarget>>;
      if (selectedRepositoryId !== undefined) {
        try {
          target = await findTarget();
          if (target === undefined && repositoryId === defaultRepositoryId) {
            const legacy = await sessionPrStatus(session);
            if (legacy?.number === number) target = await findTarget(legacy);
          }
        } catch {
          reply.code(503);
          return {
            code: 'merge_status_unavailable',
            error: 'pull request status is unavailable',
          };
        }
      }
      if (selectedRepositoryId !== undefined && target === undefined) {
        reply.code(404);
        return { error: 'pull request is not associated with this session and repository' };
      }
      const readStatus = async () =>
        target === undefined ? sessionPrStatus(session) : ((await findTarget())?.status ?? null);
      if (target && deps.projectPullRequests?.defaultBranch && !target.recorded) {
        const base = await deps.projectPullRequests.defaultBranch(target.project).catch(() => null);
        if (!base) {
          reply.code(503);
          return { error: 'repository base branch is temporarily unavailable' };
        }
        if (target.head === undefined) {
          reply.code(503);
          return {
            code: 'merge_status_unavailable',
            error: 'pull request head could not be verified',
          };
        }
        if (target.head === base) {
          reply.code(409);
          return {
            error: 'a PR from the repository base branch needs a recorded session association',
          };
        }
      }
      const approvedRevision = expectedHeadSha ?? target?.status.headSha;
      let associationPersisted = target?.recorded === true;
      const readyForReset = async (branches: GitBranchService, worktree: string) => {
        // Without a scoped target there is no evidence that the attached ref is
        // the merged PR's branch, even when it happens to point at the same SHA.
        if (!target) return deps.projectPullRequests === undefined;
        if (!associationPersisted) return false;
        if (
          !target.head ||
          !approvedRevision ||
          target.defaultBranch === null ||
          target.head === target.defaultBranch
        )
          return false;
        try {
          if (
            (await branches.current(worktree)) !== target.head ||
            (await branches.headRevision?.(worktree)) !== approvedRevision ||
            (await branches.isDirty(worktree))
          )
            return false;
          if (
            (await deps.projectPullRequests?.hasOpenPullRequest?.(target.project, target.head)) !==
            false
          )
            return false;
          return true;
        } catch {
          return false;
        }
      };
      const publishSummary = (summary: PrSummary | null) => {
        if (target === undefined) applyPrSummaryAction(session, summary);
        else deps.invalidateBranchResource?.(id);
      };
      const invalidate = () => {
        if (target === undefined || target.status.repository.isDefault)
          invalidatePrSummaryAction(session);
        if (target !== undefined) deps.invalidateBranchResource?.(id);
      };
      const syncProjectCheckout = async (): Promise<boolean> => {
        if (
          target?.status.repository.isDefault === false ||
          session.projectId === null ||
          !deps.provisioner?.syncProjectCheckout
        )
          return true;
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
      let mergedPrStatus: PullRequestStatus | null = null;
      // The push payload is a routing hint, never authorization. Re-resolve the
      // session's PR at action time so a forged/stale notification cannot merge an
      // arbitrary PR from the repository. Older injected deployments without a PR
      // status resolver retain the pre-existing merge behavior.
      if (
        target !== undefined ||
        deps.branchPrStatus !== undefined ||
        deps.branchPrStatusForBranches !== undefined
      ) {
        const selection = target;
        const backend = deps.projectPullRequests;
        const current =
          selection?.head && backend?.invalidate
            ? await backend
                .invalidate(selection.project)
                .then(() => backend.status(selection.project, selection.head!, number))
                .catch(() => null)
            : (selection?.status ?? (await readStatus().catch(() => null)));
        if (current === null) {
          invalidate();
          reply.code(503);
          return {
            error: 'Pull request status is temporarily unavailable. Refresh status before merging.',
            code: 'merge_status_unavailable',
          };
        }
        mergedPrStatus = { ...current, phase: 'merged' };
        if (current?.number === number && current.phase === 'merged') {
          publishSummary(compactPr(current));
          // Preserve idempotency while still repairing a checkout left stale by
          // an external merge or an earlier failed synchronization attempt.
          if (!(await syncProjectCheckout())) {
            const note = `Pull request #${String(number)} was already merged, but the project's managed default-branch checkout could not be refreshed automatically.`;
            await deps.eventStore.appendPendingNote(id, note).catch(() => undefined);
          }
          return { merged: true };
        }
        if (
          current.number === number &&
          current.phase === 'open' &&
          current.mergeState !== 'dirty' &&
          current.viewerCanMerge !== false &&
          (current.pipeline === 'pending' ||
            current.pipeline === 'running' ||
            (current.mergeable === null && current.pipeline !== 'failure'))
        ) {
          publishSummary(compactPr(current));
          reply.code(409);
          return {
            error:
              'Pull request checks or mergeability are still being evaluated. Refresh status before merging.',
            code: 'merge_status_pending',
          };
        }
        if (
          current?.number !== number ||
          current.phase !== 'open' ||
          // Match the app: absent CI is allowed only with an affirmative provider
          // verdict; running checks and required failures still block the merge.
          current.mergeState === 'dirty' ||
          current.pipeline === 'pending' ||
          current.pipeline === 'running' ||
          (current.pipeline === 'failure' && current.mergeState !== 'unstable') ||
          current.mergeable !== true
        ) {
          publishSummary(compactPr(current));
          reply.code(409);
          return { error: `pull request #${String(number)} is no longer ready to merge` };
        }
        if (
          expectedHeadSha !== undefined &&
          current.headSha !== undefined &&
          current.headSha !== expectedHeadSha
        ) {
          publishSummary(compactPr(current));
          reply.code(409);
          return {
            error: `pull request #${String(number)} changed since it was shown; refresh before merging`,
            code: 'merge_head_changed',
          };
        }
        if (current.viewerCanMerge === false) {
          reply.code(403);
          return {
            error: new ForgeMergePermissionError().message,
            code: 'merge_permission_denied',
          };
        }
        // Read from the re-resolved PR, so it describes the pull request this
        // request is about to merge rather than whatever the push payload claimed.
        mergedBaseRef = current.baseRef;
      }
      let permissionDenied = false;
      let unknownError = false;
      if (target && !approvedRevision) {
        reply.code(409);
        return { error: 'pull request revision is unavailable' };
      }
      const merging = target
        ? deps.projectPullRequests!.merge(target.project, number, approvedRevision!)
        : expectedHeadSha === undefined
          ? deps.mergePr!(number, session.worktree)
          : deps.mergePr!(number, session.worktree, expectedHeadSha);
      const merged = await merging.catch((error: unknown) => {
        permissionDenied = error instanceof ForgeMergePermissionError;
        unknownError = !permissionDenied;
        return false;
      });
      if (!merged) {
        invalidate();
        if (permissionDenied) {
          reply.code(403);
          return {
            error: new ForgeMergePermissionError().message,
            code: 'merge_permission_denied',
          };
        }
        const rejected = await readStatus().catch(() => null);
        if (
          target === undefined &&
          !unknownError &&
          rejected?.number === number &&
          rejected.phase === 'open' &&
          rejected.viewerCanMerge !== false &&
          (rejected.mergeState === 'dirty' ||
            (rejected.pipeline === 'failure' && rejected.mergeState !== 'unstable'))
        ) {
          await conductor
            .dispatchTurn(id, buildPullRequestMergeRejectedPrompt(number), undefined, {
              displayPrompt: buildPullRequestMergeRejectedDisplayPrompt(number),
              // Without the caller as initiator, the repair turn could not use gateway tools.
              ...(request.localUserId ? { initiatedBy: { userId: request.localUserId } } : {}),
            })
            .catch(() => undefined);
        }
        reply.code(409);
        return { error: `pull request #${String(number)} could not be merged` };
      }
      if (target?.head && !target.recorded) {
        try {
          const repository = target.status.repository;
          if (repository.isDefault) {
            await deps.eventStore.upsertSessionRepositoryWorkspace({
              sessionId: id,
              projectId: target.project.id,
              repositoryId: repository.id,
              worktree: target.worktree,
              branch: target.head,
            });
          }
          await deps.eventStore.recordRepositoryPullRequest(
            target.project.id,
            repository.id,
            target.head,
            { number, head: target.head, url: target.status.url },
            id,
            true,
          );
          associationPersisted = true;
        } catch (err) {
          request.log.warn(
            { err, sessionId: id },
            'Could not persist merged pull request association',
          );
        }
      }
      const defaultCheckout = target?.status.repository.isDefault !== false;
      if (defaultCheckout) deps.beforePrCleanup?.(session);
      if (target) invalidate();
      publishSummary({
        phase: 'merged',
        pipeline: 'success',
        mergeable: false,
      });
      const projectCheckoutSyncFailed = !(await syncProjectCheckout());
      // Post-merge worktree housekeeping is deterministic and server-side: the reset
      // force-checks-out the worktree, so it must never run under a live turn. The
      // transcript marker and pending agent note are written only after the cleanup
      // attempt, so the next real turn sees the final post-merge state.
      let cleanupObserved = false;
      const finishCleanup = async (): Promise<void> => {
        cleanupObserved = true;
        if (target) deps.invalidateBranchResource?.(id);
        if (defaultCheckout)
          await deps.afterPrCleanup?.(session, mergedPrStatus).catch((err: unknown) => {
            request.log.warn({ err, sessionId: id }, 'Post-merge PR visibility update failed');
          });
      };
      const runCleanup = target
        ? conductor.runExclusive.bind(conductor)
        : conductor.runWhenIdle.bind(conductor);
      await runCleanup(id, async () => {
        const mergedPullRequest = target
          ? `${target.status.repository.owner}/${target.status.repository.repo} #${number}`
          : `#${number}`;
        let note = `Pull request ${mergedPullRequest} was merged.`;
        try {
          const branches = await branchesForSession(session);
          const worktree = target?.worktree ?? session.worktree;
          if (branches && (await readyForReset(branches, worktree))) {
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
              const settled = target?.head
                ? await deps.projectPullRequests
                    ?.status(target.project, target.head, number)
                    .catch(() => null)
                : await readStatus().catch(() => null);
              const destination =
                settled?.number === number && settled.phase === 'merged'
                  ? (settled.baseRef ?? mergedBaseRef)
                  : mergedBaseRef;
              const { base, deletedBranch, skipped } = await branches.resetToMergedBase(worktree, {
                ...(destination === undefined ? {} : { base: destination }),
                ...(target?.head && approvedRevision
                  ? { expectedHead: { branch: target.head, sha: approvedRevision } }
                  : {}),
              });
              const deletedClause = deletedBranch
                ? ` and the merged local branch "${deletedBranch}" was deleted`
                : '';
              // Purely informational — the reset already happened; the agent is not
              // instructed to do anything (the detached HEAD is the server's doing).
              if (!skipped)
                note = `Pull request ${mergedPullRequest} was merged and your worktree has been reset to ${base} (detached at the merged commit)${deletedClause}.`;
            } catch {
              // Housekeeping is non-atomic (fetch → detach → delete the merged branch):
              // on failure the worktree MAY already be reset (only the branch delete
              // failed) or not (the fetch/checkout failed). We can't tell which here, so
              // word it neutrally — never falsely claim the reset did or didn't happen.
              note = `Pull request ${mergedPullRequest} was merged, but the automatic worktree cleanup afterwards did not fully complete.`;
            }
          }
          if (projectCheckoutSyncFailed) {
            note +=
              " The project's managed default-branch checkout could not be refreshed automatically.";
          }
        } finally {
          await finishCleanup();
        }
        // The merge and cleanup need no model reasoning. Keep the detail available
        // to the agent on its next genuine turn, while showing the user one concise
        // transcript marker now. Both are best-effort because the PR already landed.
        await deps.eventStore.appendPendingNote(id, note).catch(() => undefined);
        await conductor.emitMerged(id, number).catch(() => undefined);
      }).catch(async () => {
        if (!cleanupObserved) await finishCleanup();
      });
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
    // The user who asked for the merge; the follow-up turn runs for them.
    initiatedBy?: { userId: string },
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
            await sandboxGit(['-C', session.worktree, 'rev-parse', 'HEAD'])
          ).trim();
          if (currentTip !== approvedTip) return null;
        }
        return branches.mergeIntoLocalBase(session.worktree, basePath, { git: sandboxGit });
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
          const { deletedBranch, retainedBranch, skipped } = await branches.resetToLocalBase(
            session.worktree,
            base,
            merged,
            { git: sandboxGit },
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
            ...(initiatedBy ? { initiatedBy } : {}),
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return { merged: true, base, branch };
  };

  app.post('/sessions/:id/merge', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    return mergeLocalSession(
      id,
      (status) => {
        reply.code(status);
      },
      undefined,
      request.localUserId ? { userId: request.localUserId } : undefined,
    );
  });

  return { mergeLocalSession };
}
