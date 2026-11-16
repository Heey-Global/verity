import { NO_PERSONAL_MODEL, personModelRefusal } from './turn-sandbox.js';
import { isVulnerabilityWorkspace } from './vulnerability-project.js';
import { buildVulnerabilityFixPrompt } from './vulnerability-fix.js';
import { measureBranchReadStage, type BranchReadStage } from './branch-read-diagnostics.js';
import { appendExternalPromptData } from '@verity/events';
import {
  QueueFullError,
  SessionBusyError,
  UnknownSessionError,
  worktreeExists,
  WorktreeMissingError,
  type TurnOptions,
} from '@verity/session';
import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  BranchExistsError,
  BranchInUseError,
  BranchNotFoundError,
  DirtyWorktreeError,
  InvalidBranchNameError,
} from './branches.js';
import { type PushFirePoints } from './push-fire-points.js';
import { SandboxUnavailableError } from './sandbox-git.js';
import { registerServerSessionMove } from './server-session-move.js';
import { type ServerContext } from './server-context.js';
import { registerSessionBranchReadRoute } from './session-branch-read-route.js';
import { registerSessionBranchSwitchRoute } from './session-branch-switch-route.js';
import { registerSessionControlRoutes } from './session-control-routes.js';
import { registerSessionLinkRoutes } from './session-link-routes.js';
import { registerSessionMergeRoutes } from './session-merge-routes.js';
import { registerSessionRecoveryRoute } from './session-recovery-route.js';
import { sessionParams } from './session-route-schemas.js';
import { registerSessionTurnRoute } from './session-turn-route.js';
import { legacyAdministratorId } from './view-state-routes.js';
import {
  PROJECT_MODEL_ERROR,
  projectSettingsStore,
  isControlPlaneProject,
  stripRepeatedOperatorInstructions,
  describeRejectedTurnAttachments,
  rejectedTurnAttachmentsMessage,
  turnBody,
} from './server-support.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import type { registerServerMcpRoutes } from './server-mcp-routes.js';
import type { PrRepairTurns } from './server-pr-repair.js';

type SessionOverview = ReturnType<typeof createServerSessionOverview>;

/**
 * Closures `buildServer` still owns that the session routes depend on. Each one
 * moves into `ServerContext` or into its own area's module when that area is
 * extracted from `server.ts`.
 */
export interface SessionRoutesWiring {
  sessionOverview: Pick<
    SessionOverview,
    | 'compactPr'
    | 'applyPrSummaryAction'
    | 'sessionPrCache'
    | 'sessionPrStatus'
    | 'branchesForSession'
    | 'readBranchMetadata'
    | 'localMergeTarget'
    | 'prCleanupPending'
    | 'withPrVisibility'
    | 'invalidatePrSummaryAction'
    | 'invalidateBranchCache'
  >;
  beginProjectSpawn: (projectId: string) => () => void;
  pushFirePoints: PushFirePoints | undefined;
  maybeDispatchPrRepairTurns: PrRepairTurns['maybeDispatchPrRepairTurns'];
  hasMeetingJob: (sessionId: string) => boolean;
  cancelMeetingJobs: (sessionId: string) => boolean;
  decidePendingLinkedMessage: ReturnType<typeof registerServerMcpRoutes>;
  projectAgentRejection: (model: string, projectId: string) => Promise<string | undefined>;
  isConfiguredProjectSessionModel: (model: string | undefined, viewer?: string) => Promise<boolean>;
  /** Whether anyone besides the administrator may work in the project (ADR 0023). */
  sharedProject: (projectId: string | null) => Promise<boolean>;
  /** The model a person's turns in a shared session run on; undefined elsewhere. */
  personSessionModel: (
    session: { sessionId: string; projectId: string | null; model: string },
    viewer: string,
  ) => Promise<string | undefined>;
}

/**
 * Routes that work on one session: recovery, turns, control and links, branch
 * reads, merges, saving to a project, moves and branch switches.
 */
export function installSessionRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  {
    sessionOverview,
    beginProjectSpawn,
    pushFirePoints,
    maybeDispatchPrRepairTurns,
    hasMeetingJob,
    cancelMeetingJobs,
    decidePendingLinkedMessage,
    projectAgentRejection,
    isConfiguredProjectSessionModel,
    sharedProject,
    personSessionModel,
  }: SessionRoutesWiring,
): void {
  const { deps, conductor, liveHub, projectsBeingDeleted, sessionsBeingReaped } = ctx;
  const {
    compactPr,
    applyPrSummaryAction,
    sessionPrCache,
    sessionPrStatus,
    branchesForSession,
    readBranchMetadata,
    localMergeTarget,
    prCleanupPending,
    withPrVisibility,
    invalidatePrSummaryAction,
    invalidateBranchCache,
  } = sessionOverview;

  // Steering (M3-3): trigger one operator turn on a session. We answer 202 the
  // moment it is accepted; live progress flows over the WS stream. What happens to
  // a message sent while a turn is in flight depends on the running turn:
  //   - if it's steerable (#101 Stage B, the normal case), the message is folded
  //     into the LIVE turn — claude injects it at its next step boundary — and the
  //     response flags `queued: false` (delivered, not deferred);
  //   - otherwise it's QUEUED behind the in-flight turn and runs as a fresh
  //     `--resume` turn when that settles (#90 Stage A) → `queued: true`.
  // So `queued: false` means "running now" (a fresh idle turn OR a steered one);
  // `queued: true` means "waiting behind the current turn". An unknown session →
  // 404; a full queue → 429.
  registerSessionRecoveryRoute(app, {
    store: deps.eventStore,
    ...(deps.projectCloneRoot !== undefined ? { projectCloneRoot: deps.projectCloneRoot } : {}),
    isBusy: (id) => conductor.isBusy(id),
    hasMeetingJob,
  });
  registerSessionTurnRoute(app, {
    dispatch: async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      const parsedBody = turnBody.safeParse(request.body);
      if (!parsedBody.success) {
        // Attachment-level failures are the one rejection worth reporting in
        // detail: the operator can only fix them by knowing WHICH files were
        // refused, and the whole send — prompt and valid attachments included —
        // is discarded until they do. Anything else falls through to the error
        // boundary's generic 400.
        const rejectedAttachments = describeRejectedTurnAttachments(request.body, parsedBody.error);
        if (rejectedAttachments.length === 0) throw parsedBody.error;
        request.log.warn(
          {
            attachments: rejectedAttachments.map(({ index, reason }) => ({ index, reason })),
          },
          'verity: turn carried invalid attachments',
        );
        reply.code(400);
        return {
          error: rejectedTurnAttachmentsMessage(rejectedAttachments),
          code: 'invalidAttachments',
          attachments: rejectedAttachments,
        };
      }
      const body = parsedBody.data;
      let prompt = stripRepeatedOperatorInstructions(body.prompt);
      if (prompt.trim().length === 0 && (body.attachments?.length ?? 0) === 0) {
        reply.code(400);
        return { error: 'a turn needs a prompt or at least one attachment' };
      }
      let session = await deps.eventStore.getSession(id);
      if (session?.projectId) {
        await deps.provisioner?.prepareLocalDocuments?.(session.projectId);
        session = await deps.eventStore.getSession(id);
      }
      const viewer = request.localUserId ?? legacyAdministratorId;
      // In a shared session a turn runs on its sender's own model, served by their
      // own accounts. Without one it is refused, never run on the session's model,
      // which another person's account may be what serves.
      let turnModel = body.model;
      const shared = session !== undefined && (await sharedProject(session.projectId));
      if (shared && session !== undefined) {
        turnModel ??= await personSessionModel(session, viewer);
        const refusal =
          turnModel === undefined
            ? NO_PERSONAL_MODEL
            : await personModelRefusal(deps.eventStore, session.projectId!, viewer, turnModel);
        if (refusal !== undefined) {
          reply.code(400);
          return { error: refusal };
        }
        if (turnModel === session.model && body.model === undefined) turnModel = undefined;
      }
      if (
        !(await isConfiguredProjectSessionModel(turnModel ?? session?.model, viewer)) &&
        session?.projectId != null
      ) {
        reply.code(400);
        return { error: PROJECT_MODEL_ERROR };
      }
      // Existing sessions keep their model, but a turn override is new work on its chosen agent.
      if (turnModel !== undefined && turnModel !== session?.model && session?.projectId != null) {
        const rejection = await projectAgentRejection(turnModel, session.projectId);
        if (rejection !== undefined) {
          reply.code(400);
          return { error: rejection };
        }
      }
      // Recorded only once every check above accepted it.
      if (shared && body.model !== undefined)
        await deps.eventStore.userProviderConnections.setSessionModel(id, viewer, body.model);
      // SBX-4: reject a turn against a project whose sandbox cannot become active
      // (stopped/failed/restarting) up front — 409 + repair hint — instead of
      // dispatching a doomed `docker exec` that would just crash the turn. Sleeping
      // and waking projects continue to dispatch: foreground turn preparation joins
      // their automatic wake before attempting container work.
      // Mirrors the session-spawn route's `state !== 'active'` gate. An unknown
      // session is left to dispatchTurn's 404 below.
      if (session?.projectId != null) {
        const project = await deps.eventStore.getProject(session.projectId);
        if (
          project !== undefined &&
          !isControlPlaneProject(project) &&
          project.state !== 'active' &&
          project.state !== 'sleeping' &&
          project.state !== 'waking'
        ) {
          reply.code(409);
          return {
            error: `project ${project.id} sandbox is not active (${project.state}) — repair it and retry`,
          };
        }
      }
      let vulnerabilityDisplayPrompt: string | undefined;
      if (body.vulnerabilityFix) {
        if (!session?.projectId || !isVulnerabilityWorkspace(session))
          return reply.code(409).send({ error: 'A Code session is required.' });
        if (session.planning === 'active' || body.permissionMode === 'plan')
          return reply
            .code(409)
            .send({ error: 'Leave planning before starting a vulnerability fix.' });
        const fix = await buildVulnerabilityFixPrompt(
          deps.eventStore,
          session.projectId,
          body.vulnerabilityFix,
          id,
        );
        prompt = fix.prompt;
        vulnerabilityDisplayPrompt = fix.displayPrompt;
      }
      const opts: TurnOptions = {
        permissionMode: body.permissionMode,
        model: turnModel,
        timeoutMs: body.timeoutMs,
        allowedTools: body.allowedTools,
        disallowedTools: body.disallowedTools,
        attachments: body.attachments,
      };
      // The session's project is mid-delete: its worktree is about to be (or is
      // being) purged, so a turn accepted here would run against a directory
      // disappearing under it. 409 like the sandbox gate above — the delete
      // either completes and takes the session with it, or fails and hands the
      // session back, and a retry then lands on a real answer either way.
      //
      // Checked HERE rather than at the top of the route: the flag is set
      // synchronously by the delete's quiesce, so this last read before the
      // dispatch below — with no `await` between the two — cannot be overtaken.
      // A check at the top could be, by a delete that starts during either
      // store read above, and the turn would dispatch into a purged worktree.
      // A delete that marks the session AFTER this line instead finds the turn
      // in flight and cancels it, which is the case the quiesce already covers.
      if (sessionsBeingReaped.has(id)) {
        reply.code(409);
        return { error: 'session is being deleted with its project' };
      }
      let queued: boolean;
      try {
        // The authenticated caller is the turn's initiator (ADR 0023 §2) and the
        // recipient of its notifications. Taken from the auth gate, never the body.
        // Quick replies add their idempotency key; with neither, the turn keeps the
        // plain 3-arg dispatch.
        const dispatchOpts = {
          ...(vulnerabilityDisplayPrompt ? { displayPrompt: vulnerabilityDisplayPrompt } : {}),
          ...(body.clientReplyId !== undefined ? { clientReplyId: body.clientReplyId } : {}),
          ...(body.queueBehindActiveTurn ? { queueBehindActiveTurn: true } : {}),
          ...(request.localUserId ? { initiatedBy: { userId: request.localUserId } } : {}),
        };
        ({ queued } =
          Object.keys(dispatchOpts).length > 0
            ? await conductor.dispatchTurn(id, prompt, opts, dispatchOpts)
            : await conductor.dispatchTurn(id, prompt, opts));
      } catch (error) {
        if (error instanceof UnknownSessionError) {
          reply.code(404);
          return { error: `session ${id} not found` };
        }
        if (error instanceof QueueFullError) {
          reply.code(429);
          return { error: `session ${id} already has too many turns queued` };
        }
        if (error instanceof SessionBusyError) {
          reply.code(409);
          return { error: `session ${id} is completing a stop or backend handoff` };
        }
        if (error instanceof WorktreeMissingError) {
          // The session's worktree is gone (e.g. an isolated worktree cleaned up
          // after its PR merged) — unresumable. 410 Gone, not a spawn-failure 500.
          reply.code(410);
          return {
            error: `session ${id} can no longer be resumed: its workspace no longer exists`,
          };
        }
        throw error; // unexpected → error boundary → sanitized 500
      }
      reply.code(202);
      return { sessionId: id, accepted: true as const, queued };
    },
  });

  // Stop the in-flight turn of a session (issue #79). 404 if the session is
  // unknown; otherwise 200 with `cancelled` — true if a turn was actually running
  // and got signalled (the agent is SIGTERMed and an `interrupted` event lands on
  // the stream), false if the session was idle (a harmless no-op, so the button is
  // safe to tap on a race where the turn just finished).
  //
  // Stop halts the WHOLE session, not just the current turn: it FIRST drops the
  // pending backlog (messages the operator queued behind the running turn), then
  // signals the in-flight turn. Order matters — the queue must be cleared before
  // the cancelled turn settles, or its settle drains the next queued message into a
  // fresh turn and Stop appears not to work (the very bug #79's button promises to
  // prevent). The dropped prompts come back in `droppedQueued` so the app can
  // restore them to the input to edit/resend — a Stop never silently eats a typed
  // message. (This queue-clearing is specific to the operator's Stop button; the
  // internal cancel on a model switch calls `conductor.cancelTurn` directly and
  // keeps the backlog.)
  //
  // `force: true` is the operator's override for the one state an ordinary Stop
  // cannot clear: a session fenced because the previous agent process could not be
  // proven dead. Without it the barrier that keeps two agents off one worktree has no
  // manual exit, and a worker that is alive but whose control plane never answers
  // leaves the session reserved indefinitely. It is deliberately a flag on Stop
  // rather than its own endpoint — the operator's intent is the same ("give me this
  // session back"), only the evidence differs. Safe on a session that is not fenced:
  // `forceReleased` then comes back false and nothing else changes.
  registerSessionControlRoutes(app, {
    store: deps.eventStore,
    conductor,
    cancelMeetingJobs,
    permissionResolved: (id, toolUseId) => pushFirePoints?.permissionResolved(id, toolUseId),
    ...(decidePendingLinkedMessage === undefined ? {} : { decidePendingLinkedMessage }),
  });
  registerSessionLinkRoutes(app, deps.eventStore);
  // The current + switchable + previewable branches of a session's worktree.
  // `switchable` = local branches not checked out elsewhere (#91); `previewable` =
  // pushed `origin/*` branches the cockpit can preview live, INCLUDING ones a
  // sibling worktree is developing (#122). 404 unknown session; 503 when no
  // project repo is configured (scratch deployments).
  /** Null for a project not on Forgejo; 'unknown' for a Forgejo project whose
   *  connection is gone, so the caller never falls back to the broker remote. */
  const forgejoWebHost = async (
    projectId: string | null,
  ): Promise<{ baseUrl: string; identity: { owner: string; repo: string } } | 'unknown' | null> => {
    if (projectId === null) return null;
    const project = await deps.eventStore.getProject(projectId);
    if (project?.kind !== 'forgejo') return null;
    if (!project.forgeConnectionId) return 'unknown';
    const connection = await deps.eventStore.forgeConnections.get(project.forgeConnectionId);
    if (connection?.provider !== 'forgejo') return 'unknown';
    return {
      baseUrl: connection.baseUrl,
      identity: { owner: project.owner, repo: project.repo },
    };
  };
  registerSessionBranchReadRoute(app, {
    list: async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      const session = await deps.eventStore.getSession(id);
      if (!session) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      const branches = await branchesForSession(session);
      if (!branches) {
        reply.code(503);
        return { error: 'branch switching is not configured' };
      }
      if (!(await worktreeExists(session.worktree))) {
        return {
          current: '',
          switchable: [],
          previewable: [],
          workspaceMissing: true,
          currentPr: null,
          pullRequest: null,
        };
      }
      const readStage = <T>(stage: BranchReadStage, read: () => Promise<T>): Promise<T> =>
        measureBranchReadStage(stage, read, (timing) =>
          request.log.info(timing, 'verity: slow branch read stage'),
        );
      const branchState = await readStage('metadata', () =>
        readBranchMetadata(branches, session.worktree).catch((error: unknown) => {
          request.log.warn(
            {
              sessionId: id,
              worktree: session.worktree,
              errorType: error instanceof Error ? error.constructor.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
            },
            'verity: branch list degraded because git metadata is unavailable',
          );
          return null;
        }),
      );
      if (branchState === null) {
        return {
          current: '',
          switchable: [],
          previewable: [],
          workspaceMissing: true,
          currentPr: null,
          pullRequest: null,
        };
      }
      const { current, switchable, previewableRaw } = branchState;
      // A branch that's locally switchable here doesn't also need a preview row —
      // dedupe so each pushed branch shows in exactly one section.
      const switchableSet = new Set(switchable);
      const previewable = previewableRaw.filter((b) => !switchableSet.has(b));
      // Best-effort open-PR lookup for the session (#125). Uses the multi-branch
      // resolver so a session whose PR is on a branch other than its worktree HEAD
      // still shows the PR strip; degrades to the current-branch lookup, then to the
      // number-only dep. Newer deployments return the compact PR status for the
      // composer strip; older deps can still provide only the number. Failures
      // degrade to null, never failing the list.
      const rawPullRequest =
        deps.branchPrStatusForBranches !== undefined || deps.branchPrStatus !== undefined
          ? await readStage('pr', () =>
              sessionPrCache.get(session, {
                priority: true,
                load: () => sessionPrStatus(session, current),
              }),
            )
          : undefined;
      const pullRequest =
        rawPullRequest === undefined ? undefined : (sessionPrCache.peek(session.worktree) ?? null);
      const currentPr =
        pullRequest !== undefined
          ? (pullRequest?.number ?? null)
          : deps.branchPr
            ? await readStage('pr', () =>
                deps.branchPr!(current, session.worktree).catch(() => null),
              )
            : undefined;
      await maybeDispatchPrRepairTurns(session, rawPullRequest);
      // Best-effort GitHub identity (#161): owner/repo for the mobile header to build
      // tappable Issue/PR chip URLs. Omitted entirely when there's no resolver or no
      // GitHub remote (resolves to null), and a rejection degrades to omitted — the
      // chips then stay non-tappable rather than failing the branch list.
      const remoteIdentity = deps.repoIdentity
        ? await readStage('identity', () => deps.repoIdentity!(session.worktree).catch(() => null))
        : null;
      // A Forgejo project's chips link to its own instance; its origin remote is
      // the sandbox broker, so the identity comes from the project record.
      const forgeHost = await forgejoWebHost(session.projectId).catch(() => 'unknown' as const);
      // Without its connection a Forgejo project's remote is still the broker;
      // unlinked chips beat links to an unrelated GitHub repository.
      const identity =
        forgeHost === 'unknown' ? null : forgeHost === null ? remoteIdentity : forgeHost.identity;
      // A `local` project has no PR strip to merge from, so the cockpit needs to know
      // that merging into the project's base branch is possible here at all, and what
      // that base is called. File changes determine strip visibility; the merge
      // endpoint still re-checks every precondition when Save is tapped.
      const warnLocalSaveRead = (operation: string, error: unknown): void => {
        request.log.warn(
          {
            sessionId: id,
            worktree: session.worktree,
            operation,
            err: error,
            stderr:
              error !== null && typeof error === 'object' && 'stderr' in error
                ? String(error.stderr)
                : undefined,
          },
          'verity: local project save status unavailable',
        );
      };
      const { localBase, hasChanges } = await readStage('localChanges', async () => {
        const localBase = await localMergeTarget(session)
          .then(async (target) =>
            target === undefined ? null : await branches.current(target.basePath, session.worktree),
          )
          .catch((error: unknown) => {
            warnLocalSaveRead('base branch', error);
            return null;
          });
        const hasChanges =
          localBase !== null
            ? await branches
                .hasProjectChanges(session.worktree, localBase)
                .catch((error: unknown) => {
                  warnLocalSaveRead('file changes', error);
                  return false;
                })
            : false;
        return { localBase, hasChanges };
      });
      return {
        current,
        switchable,
        previewable,
        ...(currentPr !== undefined ? { currentPr } : {}),
        ...(pullRequest !== undefined ? { pullRequest } : {}),
        ...(identity !== null ? { owner: identity.owner, repo: identity.repo } : {}),
        ...(forgeHost !== null && forgeHost !== 'unknown'
          ? { codeHost: { provider: 'forgejo' as const, baseUrl: forgeHost.baseUrl } }
          : {}),
        ...(localBase !== null ? { localMerge: { base: localBase, hasChanges } } : {}),
      };
    },
  });

  const { mergeLocalSession } = registerSessionMergeRoutes(app, {
    eventStore: deps.eventStore,
    mergePr: deps.mergePr,
    provisioner: deps.provisioner,
    branchPrStatus: deps.branchPrStatus,
    branchPrStatusForBranches: deps.branchPrStatusForBranches,
    sandboxGit: deps.sandboxGit,
    conductor,
    branchesForSession,
    localMergeTarget,
    sessionPrStatus,
    compactPr,
    applyPrSummaryAction,
    beforePrCleanup: (session) => {
      prCleanupPending.add(session.sessionId);
    },
    afterPrCleanup: (session, status) =>
      withPrVisibility(session, async () => {
        try {
          if (status?.phase === 'merged') {
            // Pre-cleanup evidence cannot identify later work, even if probing fails.
            await deps.eventStore.clearSessionPrVisibility(
              session.sessionId,
              session.worktree,
              status.url,
            );
            const branches = await branchesForSession(session);
            const fingerprint = await branches
              ?.worktreeFingerprint?.(session.worktree, false)
              .catch(() => undefined);
            if (fingerprint !== undefined)
              await deps.eventStore.resetSessionPrVisibility(
                session.sessionId,
                session.worktree,
                status.url,
                fingerprint,
              );
          }
        } finally {
          prCleanupPending.delete(session.sessionId);
          invalidatePrSummaryAction(session, true);
        }
      }),
    invalidatePrSummaryAction,
  });

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
  registerServerSessionMove({
    app,
    deps,
    conductor,
    hasMeetingJob,
    projectsBeingDeleted,
    beginProjectSpawn,
    liveHub,
    projectSettingsStore,
    invalidateBranchCache,
  });

  // Switch the working branch of a session's worktree, keeping the chat (#91).
  // The session must be idle (no in-flight turn). `onDirty` decides what happens
  // to uncommitted changes (block | stash | commit). Error mapping: 409 busy /
  // dirty / branch-in-use / name-exists, 404 no-such-branch, 400 invalid name,
  // 503 unconfigured.
  registerSessionBranchSwitchRoute(app, {
    switchBranch: async (_request, reply, id, body) => {
      const session = await deps.eventStore.getSession(id);
      if (!session) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      const branches = await branchesForSession(session);
      if (!branches) {
        reply.code(503);
        return { error: 'branch switching is not configured' };
      }
      try {
        // Sampling `isBusy` leaves a gap in which a turn can start before git
        // checkout. Claim the same per-session fence turns use and hold it for
        // the complete switch, or refuse without touching the worktree.
        const attempt = await conductor.tryRunExclusive(id, () =>
          branches.switch(session.worktree, {
            ...(body.newBranch !== undefined ? { newBranch: body.newBranch } : {}),
            ...(body.branch !== undefined ? { branch: body.branch } : {}),
            ...(body.preview !== undefined ? { preview: body.preview } : {}),
            ...(body.onDirty !== undefined ? { onDirty: body.onDirty } : {}),
          }),
        );
        if (!attempt.ran) {
          reply.code(409);
          return { error: `session ${id} is busy — finish the turn before switching branches` };
        }
        // The operator's own switch is the one branch change we can see, so drop
        // the cached label rather than making them wait out its TTL.
        invalidateBranchCache(session.worktree);
        invalidatePrSummaryAction(session);
        return { branch: attempt.value };
      } catch (error) {
        if (error instanceof DirtyWorktreeError) {
          reply.code(409);
          return {
            error: 'the worktree has uncommitted changes — commit or stash them first',
          };
        }
        if (error instanceof BranchInUseError) {
          reply.code(409);
          return { error: 'that branch is checked out in another session' };
        }
        if (error instanceof BranchExistsError) {
          reply.code(409);
          return { error: 'a branch with that name already exists' };
        }
        if (error instanceof BranchNotFoundError) {
          reply.code(404);
          return { error: 'no such branch' };
        }
        if (error instanceof InvalidBranchNameError) {
          reply.code(400);
          return { error: 'invalid branch name' };
        }
        throw error; // unexpected → error boundary → sanitized 500
      }
    },
  });
}
