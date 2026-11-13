import { aggregateUsage, type AgentEvent, type RateLimitState } from '@verity/events';
import { worktreeExists } from '@verity/session';
import type { SequencedEvent, SessionProjectionFacts, SessionRecord } from '@verity/store';
import {
  isLocalProject,
  measureLatencyPhase,
  type ProjectRecord,
  type SessionAutomationStatus,
} from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { sessionAttentionSignals } from './attention.js';
import { type GitBranchService } from './branches.js';
import { isDocumentWorkspace } from './document-workspace.js';
import type { PullRequestStatus } from './forge-provider.js';
import { noteWikiOccasion } from './wiki-occasions.js';
import type { ResourceObserver } from './live/resource-observer.js';
import { startPullRequestReadyMonitor, type PushSessionContext } from './pr-ready-push.js';
import { projectClonePath } from './provisioner.js';
import { type PushFirePoints } from './push-fire-points.js';
import { type PushRouter } from './push-router.js';
import type { ServerDeps } from './server-deps.js';
import type { ActivityProjection, SessionPrSummary, SessionSummary } from './server-types.js';
import { createSessionPrCache } from './session-pr-cache.js';
import { createPrActivityRefresh } from './pr-activity-refresh.js';
import {
  deriveSessionStatusFromProjection,
  permissionEventAwaitsInput,
  projectionTailIsSelfContained,
  sessionHasOpenTasks,
  type SessionStatus,
} from './status.js';
import {
  openChoicesFromProjection,
  pendingPermissionRequestsFromProjection,
} from './session-inbox-facts.js';
import type { createVulnerabilitySessionMonitor } from './vulnerability-session.js';
import {
  BRANCH_TTL_MS,
  IDLE_LIST_BRANCH_TTL_MS,
  NO_DISCONNECTED_SANDBOXES,
  isControlPlaneProject,
  PROJECTION_TAIL,
  ACTIVITY_BUSY_CACHE_MAX_SESSIONS,
} from './server-support.js';
import type { Conductor } from '@verity/session';

type BranchMetadata = { current: string; switchable: string[]; previewableRaw: string[] };

export interface ServerSessionOverviewOptions {
  conductor: Conductor;
  deps: ServerDeps;
  app: FastifyInstance;
  resources: Pick<ResourceObserver, 'invalidate'>;
  reconcileSessionRepairs: (projectId: string) => Promise<void>;
  sessionsBeingReaped: ReadonlySet<string>;
  maybeDispatchPrRepairTurns: (
    session: SessionRecord,
    pr: PullRequestStatus | null | undefined,
  ) => Promise<void>;
  pushRouter: PushRouter | undefined;
  pushFirePoints: PushFirePoints | undefined;
  describePushSession: (session: SessionRecord) => Promise<PushSessionContext>;
  vulnerabilitySessions: Pick<ReturnType<typeof createVulnerabilitySessionMonitor>, 'attention'>;
}

export interface ServerSessionOverview {
  prunePrSummaryCache: (liveWorktrees: ReadonlySet<string>) => void;
  pruneBranchCache: (liveWorktrees: ReadonlySet<string>) => void;
  liveStatus: (sessionId: string, events: readonly AgentEvent[]) => SessionStatus;
  prSummaryCache: Map<string, { pr: SessionPrSummary | null; at: number }>;
  compactPr: (status: PullRequestStatus | null) => SessionPrSummary | null;
  applyPrSummaryAction: (session: SessionRecord, pr: SessionPrSummary | null) => void;
  sessionPrCache: ReturnType<typeof createSessionPrCache>;
  sessionPrStatus: (session: SessionRecord, current?: string) => Promise<PullRequestStatus | null>;
  summarizeSessions: (sessions: readonly SessionRecord[]) => Promise<SessionSummary[]>;
  emptyProjectionFacts: () => SessionProjectionFacts;
  projectionEventsFor: (sessionId: string, facts: SessionProjectionFacts) => Promise<AgentEvent[]>;
  latestRateLimitsFromSequenced: (events: readonly SequencedEvent[]) => RateLimitState[];
  liveStatusFromProjection: (
    sessionId: string,
    events: readonly AgentEvent[],
    totalEventCount: number,
  ) => SessionStatus;
  sessionResumable: (session: SessionRecord) => Promise<boolean>;
  activityBusyCache: Map<
    string,
    {
      revision: string;
      lastEventSeq: number;
      busy: Promise<{
        busy: boolean;
        status: SessionStatus;
        openTasks: boolean;
        waitingPermission: boolean;
      }>;
    }
  >;
  activityLogBusy: (id: string) => Promise<{
    busy: boolean;
    status: SessionStatus;
    openTasks: boolean;
    waitingPermission: boolean;
  }>;
  AWAITING: ReadonlySet<SessionStatus>;
  branchesForSession: (session: SessionRecord) => Promise<GitBranchService | undefined>;
  currentBranchCached: (
    branches: GitBranchService,
    worktree: string,
  ) => Promise<string | undefined>;
  summarizeSession: (session: SessionRecord) => Promise<SessionSummary>;
  readBranchMetadata: (branches: GitBranchService, worktree: string) => Promise<BranchMetadata>;
  localMergeTarget: (
    session: SessionRecord,
  ) => Promise<{ basePath: string; project: ProjectRecord } | undefined>;
  prCleanupPending: Set<string>;
  withPrVisibility: <T>(session: SessionRecord, action: () => Promise<T>) => Promise<T>;
  invalidatePrSummaryAction: (session: SessionRecord, retainStatus?: boolean) => boolean;
  invalidateBranchCache: (worktree: string) => void;
}

export function createServerSessionOverview({
  conductor,
  deps,
  app,
  resources,
  reconcileSessionRepairs,
  sessionsBeingReaped,
  maybeDispatchPrRepairTurns,
  pushRouter,
  pushFirePoints,
  describePushSession,
  vulnerabilitySessions,
}: ServerSessionOverviewOptions): ServerSessionOverview {
  // A session's live status badge. The event log lags the conductor: between a
  // turn being dispatched and claude emitting its first `status: running` event,
  // the last PERSISTED status event is still the previous turn's terminal one
  // (e.g. `completed`), so an actively-running session would badge as done/idle
  // on the overview — and with several sessions working at once the indicator
  // looks like only some of them are working. Overlay the conductor's real-time
  // in-flight state (the source of truth for "working right now") onto the
  // event-derived status. The `awaiting_*` states are themselves in-flight but
  // are more specific, actionable badges than the generic `running`, so they win
  // over the overlay; only the non-live derivations (idle/completed/crashed) are
  // upgraded to `running` when the conductor still has a turn in flight.
  const AWAITING: ReadonlySet<SessionStatus> = new Set(['awaiting_input', 'awaiting_dependency']);
  const liveStatus = (sessionId: string, events: readonly AgentEvent[]): SessionStatus =>
    liveStatusFromProjection(sessionId, events, events.length);
  /** {@link liveStatus} over a projection-narrowed log — see
   *  {@link deriveSessionStatusFromProjection} for why the count travels separately. */
  const liveStatusFromProjection = (
    sessionId: string,
    events: readonly AgentEvent[],
    totalEventCount: number,
  ): SessionStatus => {
    const derived = deriveSessionStatusFromProjection(events, totalEventCount);
    if (!AWAITING.has(derived) && conductor.isBusy(sessionId)) return 'running';
    return derived;
  };

  // PR-status enrichment for the overview markers (#387). CI status moves on the
  // order of minutes, but the session list polls every ~2s — resolving each
  // session's branch + PR on every poll would spawn N git calls and hammer GitHub.
  // So keep a stale-while-revalidate cache keyed by worktree: the hot path returns
  // the last-known value instantly and schedules a background refresh when the entry
  // is missing or older than the TTL. A cold entry reads as `undefined` (no marker)
  // and fills in a poll later — fine for a slow-moving signal. Inert (returns
  // undefined, never touches git/GitHub) unless both branch + PR resolvers are wired.
  const PR_SUMMARY_TTL_MS = 15_000;
  const prSummaryCache = new Map<string, { pr: SessionPrSummary | null; at: number }>();
  const prSummaryInFlight = new Set<string>();
  const prSummaryGeneration = new Map<string, number>();
  const compactPr = (s: PullRequestStatus | null): SessionPrSummary | null =>
    s === null
      ? null
      : {
          phase: s.phase,
          pipeline: s.pipeline,
          mergeable: s.mergeable,
          ...(s.viewerCanMerge === undefined ? {} : { viewerCanMerge: s.viewerCanMerge }),
          ...(s.mergeState === undefined ? {} : { mergeState: s.mergeState }),
        };
  // Resolve the PR that represents a session. A session may span several branches
  // (a multi-phase run that pushed differently-named branches than its worktree
  // HEAD), so prefer the multi-branch resolver — it surfaces the most-recently-
  // updated OPEN PR across the session's branches, not just the worktree HEAD's.
  // Falls back to the current-branch lookup when only the older resolver is wired.
  const branchesForSession = async (
    session: SessionRecord,
  ): Promise<GitBranchService | undefined> => {
    if (isDocumentWorkspace(session.worktree)) return undefined;
    if (deps.branches === undefined) return undefined;
    if (deps.projectWorktreeBranchesOnly === true && session.projectId === null) return undefined;
    if (session.projectId !== null) {
      const project = await deps.eventStore.getProject(session.projectId);
      if (project !== undefined && isControlPlaneProject(project)) return undefined;
    }
    return deps.branches;
  };
  /**
   * The session header's branch label, cached stale-while-revalidate.
   *
   * `branches.current()` is a git invocation, and inside a project sandbox that
   * means a `docker exec` — tens of milliseconds at best, and it was running on
   * the activity poll, i.e. every 1.5 s per open session per device, to render a
   * label that changes when the operator switches branches. A cold entry still
   * awaits the call so the first poll after opening a session shows the branch;
   * after that the poll answers from memory and refreshes in the background.
   *
   * Bounded staleness is the point: a branch can also change from INSIDE the
   * sandbox (the agent checking out its own work), which no invalidation hook
   * here would see, so the TTL — not {@link invalidateBranchCache} — is what
   * guarantees the label converges.
   *
   * Keyed by worktree alone, and that is sufficient rather than sloppy:
   * {@link branchesForSession} resolves to the single `deps.branches` service or
   * to nothing, so there is no project-scoped service that could read the same
   * path differently.
   *
   * Cold reads and refreshes go through the same single-flight entry, like the
   * sandbox-update target cache in `sandbox-updates.ts`. Sharing one read per
   * worktree matters less for the duplicated `docker exec` than for the write
   * back: a read that is not in the map cannot be disowned, and a cold read is
   * exactly the case where there is no cache entry for an invalidation to delete
   * either — so a first poll racing a branch switch would land the pre-switch
   * label on the empty slot and pin it for a whole TTL.
   */
  const branchTtlMs = deps.branchCacheTtlMs ?? BRANCH_TTL_MS;
  const branchCache = new Map<string, { branch: string; at: number }>();
  // A fleet-wide list must not launch one Docker exec per retained worktree at once.
  let branchReads = 0;
  const branchReadQueue: (() => void)[] = [];
  const limitBranchRead = async <T>(read: () => Promise<T>): Promise<T> => {
    if (branchReads >= 2) await new Promise<void>((resolve) => branchReadQueue.push(resolve));
    else branchReads++;
    try {
      return await read();
    } finally {
      const next = branchReadQueue.shift();
      if (next) next();
      else branchReads--;
    }
  };
  const branchMetadata = new Map<string, { value: BranchMetadata; at: number }>();
  const branchMetadataInFlight = new Map<
    string,
    { disowned: boolean; read: Promise<BranchMetadata> }
  >();
  /** The git read currently running for a worktree, if any — both the
   *  single-flight guard and the handle an invalidation uses to disown it. A read
   *  in flight started BEFORE the switch it raced, so writing its answer back
   *  afterwards would restore the label the operator just left, freshly stamped,
   *  for a whole TTL: the cache would defeat the very invalidation written to
   *  correct it. Marking the token beats comparing map presence, because another
   *  read may have repopulated the entry in the meantime and a `delete` leaves no
   *  trace. */
  const branchInFlight = new Map<string, { disowned: boolean; read: Promise<string> }>();
  const disownBranchRefresh = (worktree: string): void => {
    const running = branchInFlight.get(worktree);
    if (running !== undefined) running.disowned = true;
  };
  const invalidateBranchCache = (worktree: string): void => {
    branchCache.delete(worktree);
    branchMetadata.delete(worktree);
    const metadataRead = branchMetadataInFlight.get(worktree);
    if (metadataRead !== undefined) metadataRead.disowned = true;
    disownBranchRefresh(worktree);
  };
  /** Read git for this worktree, or join the read already running for it, and
   *  write the answer back unless it was disowned meanwhile. */
  const readBranch = (branches: GitBranchService, worktree: string): Promise<string> => {
    const metadata = branchMetadataInFlight.get(worktree);
    if (branches.metadata && metadata && !metadata.disowned) {
      return metadata.read.then((value) => value.current);
    }
    const running = branchInFlight.get(worktree);
    // An invalidation disowns the pre-switch read immediately, but the promise
    // can remain unsettled for arbitrarily long. A poll arriving in that window
    // must start a post-switch read rather than joining the known-stale one.
    if (running !== undefined && !running.disowned) return running.read;
    const token = { disowned: false, read: limitBranchRead(() => branches.current(worktree)) };
    branchInFlight.set(worktree, token);
    token.read
      .then((branch) => {
        if (token.disowned) return;
        branchCache.set(worktree, { branch, at: Date.now() });
      })
      .catch(() => {
        // A FAILED read has to advance the clock too. Leaving the entry stale
        // means every later poll kicks another git call against the same broken
        // worktree — the per-poll cost this cache exists to remove, reinstated
        // exactly when the sandbox is least able to absorb it. Only re-stamp an
        // entry that is still there: an invalidation in the meantime must not be
        // undone by a read that failed, and a cold read has nothing to stamp.
        if (token.disowned) return;
        const current = branchCache.get(worktree);
        if (current !== undefined) branchCache.set(worktree, { ...current, at: Date.now() });
      })
      .finally(() => {
        if (branchInFlight.get(worktree) === token) branchInFlight.delete(worktree);
      });
    return token.read;
  };
  const currentBranchCached = async (
    branches: GitBranchService,
    worktree: string,
  ): Promise<string | undefined> => {
    if (branchTtlMs <= 0) return limitBranchRead(() => branches.current(worktree));
    const cached = branchCache.get(worktree);
    // A cold read is awaited so the first poll after opening a session shows a
    // branch at all; a stale one is answered from memory while git runs behind
    // it. Background refresh failures are absorbed here; a cold read still
    // propagates failure to the caller awaiting it.
    if (cached === undefined) return readBranch(branches, worktree);
    if (Date.now() - cached.at >= branchTtlMs) {
      void readBranch(branches, worktree).catch(() => {});
    }
    return cached.branch;
  };
  // Repeated PR-strip polls need current status, not a full branch enumeration
  // each time. Share branch metadata across devices and refresh it at the same
  // bounded cadence as the live branch label.
  const readBranchMetadata = (
    branches: GitBranchService,
    worktree: string,
  ): Promise<BranchMetadata> => {
    const running = branchMetadataInFlight.get(worktree);
    if (running !== undefined && !running.disowned) return running.read;
    const cached = branchMetadata.get(worktree);
    if (cached !== undefined && Date.now() - cached.at < branchTtlMs) {
      return Promise.resolve(cached.value);
    }
    if (branches.metadata) disownBranchRefresh(worktree);
    const token = {
      disowned: false,
      read: branches.metadata
        ? limitBranchRead(() => branches.metadata!(worktree))
        : Promise.all([
            readBranch(branches, worktree),
            limitBranchRead(() => branches.switchable(worktree)),
            limitBranchRead(() => branches.previewable(worktree)),
          ]).then(([current, switchable, previewableRaw]) => ({
            current,
            switchable,
            previewableRaw,
          })),
    };
    branchMetadataInFlight.set(worktree, token);
    void token.read
      .then((value) => {
        if (!token.disowned) {
          branchMetadata.set(worktree, { value, at: Date.now() });
          if (branches.metadata)
            branchCache.set(worktree, { branch: value.current, at: Date.now() });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (branchMetadataInFlight.get(worktree) === token) branchMetadataInFlight.delete(worktree);
      });
    return token.read;
  };
  /**
   * The branch for the session LIST, answered from {@link branchCache} only.
   * Idle summaries refresh at most once a minute; active sessions keep the
   * header cadence. Turn completion and explicit branch changes invalidate both.
   *
   * The overview derives a session's issue chip from it, but the list is polled
   * every 2 s for every session at once, so unlike the header it never awaits
   * git: a cold or stale entry schedules {@link readBranch} in the background and
   * the label fills in a poll later. A cold read that FAILS leaves an empty label
   * behind, stamped, so a broken worktree costs one git call per TTL rather than
   * one per poll. The app reads an empty branch as "no branch" in both places
   * (the header falls back to its branch list), and the next read replaces it.
   */
  const listBranchFor = (
    session: SessionRecord,
    exists: boolean,
    active: boolean,
  ): string | undefined => {
    const { worktree } = session;
    // A gone worktree has no branch to read; asking git would fail on every poll.
    if (!exists || deps.branches === undefined) return undefined;
    if (deps.projectWorktreeBranchesOnly === true && session.projectId === null) return undefined;
    const cached = branchCache.get(worktree);
    const ttlMs = active ? branchTtlMs : Math.max(branchTtlMs, IDLE_LIST_BRANCH_TTL_MS);
    if (cached === undefined || Date.now() - cached.at >= ttlMs) {
      void branchesForSession(session)
        .then((branches) => {
          // A project without branch reads (control plane) is stamped empty too,
          // so it is not asked for its project record on every poll either.
          if (branches === undefined) branchCache.set(worktree, { branch: '', at: Date.now() });
          else return readBranch(branches, worktree);
        })
        .catch(() => {
          // `readBranch` re-stamps an existing entry on failure; only a cold one is left.
          if (!branchCache.has(worktree)) branchCache.set(worktree, { branch: '', at: Date.now() });
        });
    }
    return cached?.branch || undefined;
  };
  /** Evict labels for worktrees that no longer exist, so a long-lived server does
   *  not keep one entry per session ever created — and a recreated worktree can
   *  never be answered from the deleted one's label. Same lifecycle and same call
   *  site as {@link prunePrSummaryCache}: the full-list route is where every live
   *  worktree is visible at once. A client that never listed sessions would never
   *  prune, but it also could not have opened one, so the map stays bounded by the
   *  worktrees this process actually served. */
  const pruneBranchCache = (liveWorktrees: ReadonlySet<string>): void => {
    for (const worktree of new Set([
      ...branchCache.keys(),
      ...branchMetadata.keys(),
      ...branchMetadataInFlight.keys(),
    ])) {
      if (!liveWorktrees.has(worktree)) invalidateBranchCache(worktree);
    }
    // A refresh can outlive the entry it was started for, so eviction has to reach
    // the in-flight ones too — otherwise the dead worktree's label is written back
    // after the prune and the map grows by exactly the entries this is here to drop.
    for (const worktree of branchInFlight.keys()) {
      if (!liveWorktrees.has(worktree)) disownBranchRefresh(worktree);
    }
  };

  /** The managed base checkout a session can merge into WITHOUT GitHub. Only
   *  `local` projects have one: a GitHub-backed project merges through its pull
   *  request, which stays the single canonical path for anything with a remote.
   *  Undefined whenever that isn't the case (no project, GitHub-backed, or no
   *  configured clone root), which is exactly the signal to hide the local merge. */
  const localMergeTarget = async (
    session: SessionRecord,
  ): Promise<{ basePath: string; project: ProjectRecord } | undefined> => {
    if (isDocumentWorkspace(session.worktree)) return undefined;
    if (session.projectId === null || deps.projectCloneRoot === undefined) return undefined;
    const project = await deps.eventStore.getProject(session.projectId);
    if (project === undefined || !isLocalProject(project)) return undefined;
    return { basePath: projectClonePath(deps.projectCloneRoot, project), project };
  };
  const sessionPrStatus = async (
    session: SessionRecord,
    current?: string,
  ): Promise<PullRequestStatus | null> => {
    const { worktree } = session;
    const branches = await branchesForSession(session);
    if (!branches) return null;
    if (deps.branchPrStatusForBranches) {
      const sessionBranches = await branches
        .sessionBranches(worktree)
        .catch(async () => [current ?? (await branches.current(worktree))]);
      return deps.branchPrStatusForBranches(sessionBranches, worktree);
    }
    if (deps.branchPrStatus) {
      return deps.branchPrStatus(current ?? (await branches.current(worktree)), worktree);
    }
    return null;
  };
  const prCleanupPending = new Set<string>();
  const prVisibilityWrites = new Map<string, Promise<void>>();
  const withPrVisibility = async <T>(
    session: SessionRecord,
    action: () => Promise<T>,
  ): Promise<T> => {
    const key = session.worktree;
    const previous = prVisibilityWrites.get(key);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    prVisibilityWrites.set(key, pending);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (prVisibilityWrites.get(key) === pending) prVisibilityWrites.delete(key);
    }
  };
  const sessionPrCache = createSessionPrCache({
    load: sessionPrStatus,
    present: (session, status) =>
      withPrVisibility(session, async () => {
        if (!status || status.phase === 'open' || prCleanupPending.has(session.sessionId))
          return status;
        const saved = await deps.eventStore.getSessionPrVisibility(
          session.sessionId,
          session.worktree,
          status.url,
        );
        if (saved?.hidden) return null;
        const branches = await branchesForSession(session);
        const fingerprint = await branches?.worktreeFingerprint?.(session.worktree, false);
        // An unavailable workspace is not evidence that work resumed.
        if (fingerprint === undefined) return status;
        const hidden = await deps.eventStore.observeSessionPrVisibility(
          session.sessionId,
          session.worktree,
          status.url,
          fingerprint,
        );
        return hidden ? null : status;
      }),
    now: deps.pullRequestCacheNow,
    onChange: (session, status) => {
      prSummaryCache.set(session.worktree, { pr: compactPr(status), at: Date.now() });
      // A merged change is when the product changed. The occasion is recorded once
      // per pull request; a cache refilled after a restart reports it again. It
      // names the pull request only: the session's conversation is kept for the
      // Wiki solely when the user deletes the session as done.
      if (status?.phase === 'merged' && session.projectId !== null)
        void noteWikiOccasion(
          deps.eventStore,
          {
            projectId: session.projectId,
            kind: 'merge',
            ref: status.url,
            title: `#${String(status.number)} ${status.title}`,
            body: `Merged pull request ${status.url} from session ${session.sessionId}.`,
          },
          app.log,
        );
      // Cache completion is not an HTTP mutation; without this the overview waits
      // for a later observation even though the opened session already knows the PR.
      resources.invalidate(`/sessions/${encodeURIComponent(session.sessionId)}/branches`);
    },
  });
  // App-driven status refreshes cannot discover failures while every client is
  // closed. Keep repair discovery independent of push registration and presence.
  let prRepairStopped = false;
  let prRepairSweep: Promise<void> | undefined;
  let prRepairTimer: ReturnType<typeof setInterval> | undefined;
  const sweepPrRepairs = (): Promise<void> | undefined => {
    if (prRepairStopped || prRepairSweep !== undefined) return prRepairSweep;
    prRepairSweep = (async () => {
      if (deps.secretCipher?.isSealed() === true) return;
      const sessions = await deps.eventStore.listSessions();
      for (const projectId of new Set(sessions.flatMap((s) => (s.projectId ? [s.projectId] : []))))
        await reconcileSessionRepairs(projectId);
      const live = new Set(sessions.map((session) => session.worktree));
      sessionPrCache.prune(live);
      prunePrSummaryCache(live);
      pruneBranchCache(live);
      for (const session of sessions) {
        if (prRepairStopped) break;
        if (sessionsBeingReaped.has(session.sessionId) || !sessionPrCache.isDue(session, true))
          continue;
        try {
          if (!(await worktreeExists(session.worktree))) continue;
          await maybeDispatchPrRepairTurns(
            session,
            await sessionPrCache.get(session, { background: true }),
          );
        } catch (err) {
          app.log.warn({ err, sessionId: session.sessionId }, 'background PR repair check failed');
        }
      }
    })()
      .catch((err) => app.log.warn({ err }, 'background PR repair sweep failed'))
      .finally(() => {
        prRepairSweep = undefined;
      });
    return prRepairSweep;
  };
  app.addHook('onReady', () => {
    if (deps.branchPrStatus === undefined && deps.branchPrStatusForBranches === undefined) return;
    prRepairTimer = setInterval(
      () => void sweepPrRepairs(),
      deps.pullRequestRepairPollMs ?? 30_000,
    );
    prRepairTimer.unref();
  });
  app.addHook('onClose', async () => {
    prRepairStopped = true;
    clearInterval(prRepairTimer);
    await prRepairSweep;
  });
  const prActivityRefresh = createPrActivityRefresh({
    refresh: async (sessionId) => {
      const session = await deps.eventStore.getSession(sessionId);
      if (prRepairStopped || session === undefined) return;
      invalidateBranchCache(session.worktree);
      if (!(await prMarkerEnabled(session))) {
        resources.invalidate(`/sessions/${encodeURIComponent(sessionId)}/branches`);
        return;
      }
      if (!invalidatePrSummaryAction(session, true)) return;
      await sessionPrCache.get(session);
      resources.invalidate(`/sessions/${encodeURIComponent(sessionId)}/branches`);
    },
    onError: (err, sessionId) => app.log.warn({ err, sessionId }, 'PR activity refresh failed'),
  });
  const unsubscribePrChanges = deps.bus.subscribeAll((sessionId, { event }) => {
    if (event.t === 'tool_result' || event.t === 'result')
      prActivityRefresh.notify(sessionId, event.t === 'result');
  });
  app.addHook('onClose', async () => {
    unsubscribePrChanges();
    await prActivityRefresh.close();
  });
  const pullRequestReadyMonitor =
    pushRouter !== undefined &&
    deps.branches !== undefined &&
    (deps.branchPrStatus !== undefined || deps.branchPrStatusForBranches !== undefined)
      ? startPullRequestReadyMonitor({
          router: pushRouter,
          initiatorOf: (sessionId) => pushFirePoints?.initiatorOf(sessionId),
          listSessions: async () => {
            if ((await deps.eventStore.listDevicePushTokens()).length === 0) return [];
            const sessions = await deps.eventStore.listSessions();
            const live = await Promise.all(
              sessions.map(async (session) => ({
                session,
                exists: await worktreeExists(session.worktree),
              })),
            );
            return live.filter(({ exists }) => exists).map(({ session }) => session);
          },
          statusFor: (session) => sessionPrCache.get(session, { background: true }),
          wasSent: (sessionId, marker) =>
            deps.eventStore.hasSessionAutomationMarker(sessionId, marker),
          markSent: (sessionId, marker) => deps.eventStore.markSessionAutomation(sessionId, marker),
          claimAttempt: (sessionId, marker, now) =>
            deps.eventStore.claimPrReadyDelivery(sessionId, marker, now),
          finishAttempt: (sessionId, marker, claim, outcome, now) =>
            deps.eventStore.finishPrReadyDelivery(sessionId, marker, claim, outcome, now),
          describeSession: describePushSession,
          logger: app.log,
          ...(deps.pullRequestPushPollMs === undefined
            ? {}
            : { pollMs: deps.pullRequestPushPollMs }),
        })
      : undefined;
  app.addHook('onClose', async () => {
    await pullRequestReadyMonitor?.stop();
  });
  // GitHub is "configured for PR markers" when EITHER PR-status resolver is wired —
  // the multi-branch one doesn't require the legacy single-branch dep to be present.
  const prMarkerEnabled = async (session: SessionRecord): Promise<boolean> =>
    (await branchesForSession(session)) !== undefined &&
    (deps.branchPrStatus !== undefined || deps.branchPrStatusForBranches !== undefined);
  const refreshPrSummary = async (session: SessionRecord): Promise<void> => {
    const { worktree } = session;
    if (!(await prMarkerEnabled(session)) || prSummaryInFlight.has(worktree)) return;
    const generation = prSummaryGeneration.get(worktree) ?? 0;
    prSummaryInFlight.add(worktree);
    try {
      const status = await sessionPrCache.get(session);
      if ((prSummaryGeneration.get(worktree) ?? 0) !== generation) return;
      await maybeDispatchPrRepairTurns(session, status);
      if ((prSummaryGeneration.get(worktree) ?? 0) !== generation) return;
      prSummaryCache.set(worktree, {
        pr: compactPr(sessionPrCache.peek(worktree) ?? null),
        at: Date.now(),
      });
    } catch {
      if ((prSummaryGeneration.get(worktree) ?? 0) !== generation) return;
      // Stamp the attempt time even on failure so the TTL guard still engages —
      // otherwise a persistent git/GitHub error (rate-limit, outage) leaves the
      // entry unset and re-fires a refresh on EVERY 2s poll, the exact stampede
      // this cache exists to prevent. Keep the last-known value (or absence).
      prSummaryCache.set(worktree, {
        pr: prSummaryCache.get(worktree)?.pr ?? null,
        at: Date.now(),
      });
    } finally {
      prSummaryInFlight.delete(worktree);
    }
  };
  const applyPrSummaryAction = (session: SessionRecord, pr: SessionPrSummary | null): void => {
    const { worktree } = session;
    sessionPrCache.invalidate(worktree);
    if (session.projectId) deps.invalidateProjectPrStatus?.(session.projectId);
    prSummaryGeneration.set(worktree, (prSummaryGeneration.get(worktree) ?? 0) + 1);
    prSummaryCache.set(worktree, { pr, at: Date.now() });
  };
  const invalidatePrSummaryAction = (session: SessionRecord, retainStatus = false): boolean => {
    const { worktree } = session;
    if (!sessionPrCache.invalidate(worktree, retainStatus)) return false;
    if (session.projectId) deps.invalidateProjectPrStatus?.(session.projectId);
    prSummaryGeneration.set(worktree, (prSummaryGeneration.get(worktree) ?? 0) + 1);
    if (!retainStatus) prSummaryCache.delete(worktree);
    return true;
  };
  // Read the cached PR summary and schedule a background refresh if stale. Never
  // awaits git/GitHub, so the 2s list poll stays cheap.
  const prSummaryFor = (session: SessionRecord): SessionPrSummary | null | undefined => {
    if (
      deps.branches === undefined ||
      (deps.branchPrStatus === undefined && deps.branchPrStatusForBranches === undefined) ||
      (deps.projectWorktreeBranchesOnly === true && session.projectId === null)
    ) {
      return undefined;
    }
    const { worktree } = session;
    const cached = prSummaryCache.get(worktree);
    if (cached === undefined || Date.now() - cached.at > PR_SUMMARY_TTL_MS) {
      void refreshPrSummary(session);
    }
    return cached?.pr;
  };
  // Evict entries for worktrees no longer in the live set so the cache can't grow
  // unbounded as sessions are created/deleted over a long-lived server. Called from
  // the full-list route (which sees every live worktree at once).
  const prunePrSummaryCache = (liveWorktrees: ReadonlySet<string>): void => {
    sessionPrCache.prune(liveWorktrees);
    for (const worktree of prSummaryCache.keys()) {
      if (!liveWorktrees.has(worktree)) {
        prSummaryCache.delete(worktree);
      }
    }
    for (const worktree of prSummaryGeneration.keys()) {
      if (!liveWorktrees.has(worktree)) prSummaryGeneration.delete(worktree);
    }
  };

  /**
   * The quota states in force, most severe first.
   *
   * Takes the store's already-deduplicated `rateLimitEvents`, but keeps its own
   * dedupe rather than assuming one event per key: the keying (`providerLabel`
   * defaulting to Claude, `scope` to all models) is the same rule the store's
   * `distinct on` groups by, and the one place both can be read side by side is
   * right here. The `allowed`-without-`usedPercent` drop is NOT something the
   * store can do — it decides whether a state is worth showing at all, after the
   * newest per key has been chosen, and doing it in SQL would let an older,
   * showable state resurface as the newest of its group.
   */
  const latestRateLimitsFromSequenced = (events: readonly SequencedEvent[]): RateLimitState[] => {
    const seenLimits = new Set<string>();
    const latest: RateLimitState[] = [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const { event, ts } = events[i]!;
      if (event.t !== 'rate_limit') continue;
      const providerLabel = event.providerLabel ?? 'Claude';
      const key = `${providerLabel}\0${event.window}\0${event.scope ?? 'all_models'}`;
      if (seenLimits.has(key)) continue;
      seenLimits.add(key);
      if (event.status === 'allowed' && event.usedPercent === undefined) continue;
      latest.push({
        status: event.status,
        resetsAt: event.resetsAt,
        window: event.window,
        ...(event.usedPercent !== undefined ? { usedPercent: event.usedPercent } : {}),
        ...(event.scope !== undefined ? { scope: event.scope } : {}),
        providerLabel,
        observedAt: ts,
      });
    }
    return latest.sort((a, b) => {
      const activeDelta = Number(a.status === 'allowed') - Number(b.status === 'allowed');
      if (activeDelta !== 0) return activeDelta;
      return b.resetsAt - a.resetsAt;
    });
  };

  /** A fresh zeroed fact set for a session the store returned nothing for. A
   *  shared constant would hand every caller the same mutable `events` array —
   *  the field is a plain array by contract, and the store's own path pushes into
   *  it. */
  const emptyProjectionFacts = (): SessionProjectionFacts => ({
    eventCount: 0,
    lastEventSeq: 0,
    lastActivityAt: null,
    events: [],
    eventsTruncated: false,
    rateLimitEvents: [],
    usage: aggregateUsage([]),
  });

  /**
   * The events the status projection runs over, taken from a fact set's tail
   * wherever that is provably enough.
   *
   * Both readers of these events — `deriveSessionStatusFromProjection` and
   * `permissionEventAwaitsInput` — stop at the most recent non-steered `prompt`,
   * so a tail that reaches back past one answers identically to the whole slice;
   * `projectionTailIsSelfContained` is where that argument lives. A tail short of
   * the limit IS the whole slice. Anything else falls back to the full read: one
   * turn can emit an unbounded run of `task` and `permission` events, and being
   * slow on that session is better than being wrong about it.
   */
  // Full projection reads can hydrate unbounded histories. Keep their pool
  // demand bounded across overlapping overview and detail requests, and let
  // sockets and timers run between large result-decoding bursts.
  let fullProjectionReadTail: Promise<void> = Promise.resolve();
  const projectionEventsFor = async (
    sessionId: string,
    facts: SessionProjectionFacts,
  ): Promise<AgentEvent[]> => {
    const tail = facts.events.map((event) => event.event);
    if (!facts.eventsTruncated || projectionTailIsSelfContained(tail)) return tail;
    const read = fullProjectionReadTail.then(async () => {
      await yieldToEventLoop();
      return deps.eventStore.listSessionProjectionEvents([sessionId], facts.lastEventSeq);
    });
    // A failed read must not poison later requests.
    fullProjectionReadTail = read.then(
      () => undefined,
      () => undefined,
    );
    const full = (await read).get(sessionId);
    return (full ?? []).map((event) => event.event);
  };

  /**
   * Summarize several sessions with ONE pass over the event table.
   *
   * The overview reads four things out of a log — badge, token totals, rate-limit
   * states and the event count — and every one of them is decided by a handful of
   * event kinds (`SESSION_PROJECTION_EVENT_TYPES`). Summarizing per session used
   * to hydrate each FULL log to get them, so this route's cost grew with total
   * history rather than with session count, on a path polled every ~2 s per
   * device. `listSessionProjectionFacts` answers all of it without hydrating any
   * of them: four batched queries per 500 sessions, and the only part that still
   * carries payloads is bounded to `PROJECTION_TAIL` events per session.
   */
  const summarizeSessions = async (
    sessions: readonly SessionRecord[],
  ): Promise<SessionSummary[]> => {
    const ids = sessions.map((session) => session.sessionId);
    const [facts, pendingLinks, automations] = await Promise.all([
      measureLatencyPhase('session_projection', () =>
        deps.eventStore.listSessionProjectionFacts(ids, PROJECTION_TAIL),
      ),
      measureLatencyPhase('session_links', () => deps.eventStore.pendingSessionLinkMessageIds(ids)),
      measureLatencyPhase('session_automations', () =>
        deps.eventStore.listSessionAutomationStatuses(ids),
      ),
    ]);
    const missing: SessionRecord[] = [];
    const resumable = new Map<string, boolean>();
    for (const session of sessions) {
      const exists = await worktreeExists(session.worktree);
      resumable.set(session.sessionId, exists);
      if (!exists) missing.push(session);
    }
    const restorable = await deps.sessionStorage?.canRestoreMany(missing);
    for (const [id, value] of restorable ?? []) resumable.set(id, value);
    const fallbackIds = ids.filter((id) => {
      const entry = facts.get(id);
      return (
        entry?.eventsTruncated &&
        !projectionTailIsSelfContained(entry.events.map(({ event }) => event))
      );
    });
    const boundaries = new Map(fallbackIds.map((id) => [id, facts.get(id)!.lastEventSeq]));
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const prepared = new Map<string, SessionSummary>();
    const prepare = (session: SessionRecord, events: AgentEvent[]) =>
      summarizeSessionWithFacts(
        session,
        facts.get(session.sessionId) ?? emptyProjectionFacts(),
        pendingLinks.get(session.sessionId) ?? [],
        automations.get(session.sessionId),
        events,
        resumable.get(session.sessionId) ?? false,
      );
    const fallbackRead = fullProjectionReadTail.then(async () => {
      await yieldToEventLoop();
      await deps.eventStore.visitSessionProjectionEvents(boundaries, async (id, events) => {
        prepared.set(
          id,
          await prepare(
            byId.get(id)!,
            events.map(({ event }) => event),
          ),
        );
      });
    });
    fullProjectionReadTail = fallbackRead.then(
      () => undefined,
      () => undefined,
    );
    await fallbackRead;
    return Promise.all(
      sessions.map(
        async (session) =>
          prepared.get(session.sessionId) ??
          (await prepare(
            session,
            facts.get(session.sessionId)?.events.map(({ event }) => event) ?? [],
          )),
      ),
    );
  };

  /**
   * What `GET /sessions/:id/activity` needs out of the log, read as a bounded
   * tail wherever that is provably enough.
   *
   * This is the hottest read in the server — every 1.5 s for every idle session —
   * and it used to hydrate the session's ENTIRE projection slice to answer one
   * question about the end of it. Measured on a seeded log the slice runs ~1.6 KB
   * per event, so an idle 800-prompt session cost ~50 MB a minute. Nothing keeps
   * the objects, but V8 does not hand the peak back to the OS, so the churn shows
   * up as resident memory that never falls.
   *
   * The tail is only accepted when it answers identically to the full slice, and
   * `projectionTailIsSelfContained` is where that argument lives. Two ways it can
   * be enough: the tail reaches back past a non-steered `prompt` (nothing earlier
   * is observable), or it is short of `PROJECTION_TAIL` and is therefore
   * the whole slice already. Otherwise this falls back to the full read — a
   * single turn can emit an unbounded run of `task` and `permission` events, and
   * being slow on one is better than being wrong on it.
   */
  const activityProjection = async (id: string): Promise<ActivityProjection> => {
    const tail = await deps.eventStore.listRecentSessionProjectionEvents(id, PROJECTION_TAIL);
    const events = tail.map((event) => event.event);
    // Short of the limit means the query ran out of rows, not out of budget.
    const truncated = tail.length === PROJECTION_TAIL;
    if (truncated && !projectionTailIsSelfContained(events)) {
      const full = ((await deps.eventStore.listSessionProjectionEvents([id])).get(id) ?? []).map(
        (event) => event.event,
      );
      return { events: full, hasTaskLifecycle: full.some((event) => event.t === 'task') };
    }
    return {
      events,
      // Unlike the status derivation, this gate asks about the WHOLE log rather
      // than the current turn, so a `task` older than the tail still counts and
      // the tail cannot see it. Only pay for the extra lookup when the tail is
      // genuinely short of the answer: an untruncated tail IS the whole slice,
      // and one that already holds a `task` has answered the question itself.
      hasTaskLifecycle:
        events.some((event) => event.t === 'task') ||
        (truncated && (await deps.eventStore.sessionHasTaskLifecycleEvent(id))),
    };
  };

  const activityBusyCache = new Map<
    string,
    {
      revision: string;
      lastEventSeq: number;
      busy: Promise<{
        busy: boolean;
        status: SessionStatus;
        openTasks: boolean;
        waitingPermission: boolean;
      }>;
    }
  >();
  const activityLogBusy = async (
    id: string,
  ): Promise<{
    busy: boolean;
    status: SessionStatus;
    openTasks: boolean;
    waitingPermission: boolean;
  }> => {
    const stats = await deps.eventStore.getSessionEventStats(id);
    const cached = activityBusyCache.get(id);
    if (
      stats !== undefined &&
      cached?.revision === stats.revision &&
      cached.lastEventSeq === stats.lastEventSeq
    ) {
      // Refresh insertion order so sessions no longer polled leave the bounded cache.
      activityBusyCache.delete(id);
      activityBusyCache.set(id, cached);
      return cached.busy;
    }
    activityBusyCache.delete(id);
    const busy = activityProjection(id).then(({ events, hasTaskLifecycle }) => {
      const status = deriveSessionStatusFromProjection(events, events.length);
      const openTasks = sessionHasOpenTasks(events);
      return {
        busy: hasTaskLifecycle && (status === 'running' || (AWAITING.has(status) && openTasks)),
        status,
        openTasks,
        waitingPermission: permissionEventAwaitsInput(events),
      };
    });
    if (stats === undefined) return busy;
    // Cache only the pure log result, never conductor state or payload arrays.
    // Revision catches lower-seq commits and removed provisional events; seq
    // separates a deleted/recreated session whose revision starts over.
    const entry = { revision: stats.revision, lastEventSeq: stats.lastEventSeq, busy };
    activityBusyCache.set(id, entry);
    if (activityBusyCache.size > ACTIVITY_BUSY_CACHE_MAX_SESSIONS) {
      const oldest = activityBusyCache.keys().next().value;
      if (oldest !== undefined) activityBusyCache.delete(oldest);
    }
    try {
      return await busy;
    } catch (error) {
      if (activityBusyCache.get(id) === entry) activityBusyCache.delete(id);
      throw error;
    }
  };

  const summarizeSession = async (session: SessionRecord): Promise<SessionSummary> => {
    const [facts, pendingLinks, automations] = await Promise.all([
      deps.eventStore.listSessionProjectionFacts([session.sessionId], PROJECTION_TAIL),
      deps.eventStore.pendingSessionLinkMessageIds([session.sessionId]),
      deps.eventStore.listSessionAutomationStatuses([session.sessionId]),
    ]);
    return summarizeSessionWithFacts(
      session,
      facts.get(session.sessionId) ?? emptyProjectionFacts(),
      pendingLinks.get(session.sessionId) ?? [],
      automations.get(session.sessionId),
    );
  };

  const sessionResumable = async (session: SessionRecord): Promise<boolean> =>
    (await worktreeExists(session.worktree)) ||
    (await deps.sessionStorage?.canRestore(session)) === true;

  const summarizeSessionWithFacts = async (
    session: SessionRecord,
    facts: SessionProjectionFacts,
    pendingLinks: readonly string[] = [],
    automationStatus?: SessionAutomationStatus,
    preparedEvents?: AgentEvent[],
    preparedResumable?: boolean,
  ): Promise<SessionSummary> => {
    const events = preparedEvents ?? (await projectionEventsFor(session.sessionId, facts));
    const pr = prSummaryFor(session);
    const pullRequest = pr === undefined ? undefined : sessionPrCache.peek(session.worktree);
    const resumable = preparedResumable ?? (await sessionResumable(session));
    // Not from `events`: the quota state in force can be older than any tail, so
    // the store reads the newest one per window separately. See
    // `SessionProjectionFacts.rateLimitEvents`.
    const rateLimits = latestRateLimitsFromSequenced(facts.rateLimitEvents);
    const rateLimit = rateLimits[0];
    const conductorPermissions = conductor.pendingPermissions(session.sessionId);
    const pendingPermissions = [...new Set([...conductorPermissions, ...pendingLinks])];
    const pendingPermissionRequests = pendingPermissionRequestsFromProjection(
      events,
      conductorPermissions,
    );
    // Unread counts include only agent text; the seq still identifies a nonempty log.
    const projectedStatus = liveStatusFromProjection(
      session.sessionId,
      events,
      facts.lastEventSeq === 0 ? 0 : 1,
    );
    // A permission event is durable so reconnect can rebuild its card, but its
    // answer travels over the live runner channel. Once that channel no longer
    // reports the prompt, do not let the historical event keep the overview in
    // "Needs input" while the approved operation continues or settles.
    const status =
      pendingLinks.length > 0
        ? 'awaiting_input'
        : projectedStatus === 'awaiting_input' &&
            permissionEventAwaitsInput(events) &&
            pendingPermissions.length === 0
          ? conductor.isBusy(session.sessionId)
            ? 'running'
            : 'completed'
          : projectedStatus;
    const busy = conductor.isBusy(session.sessionId);
    const branch = listBranchFor(
      session,
      resumable,
      busy || status === 'running' || sessionHasOpenTasks(events),
    );
    const openChoices = openChoicesFromProjection(events, status, busy);
    // A `Set` the relay reconciler already maintains; this adds one `Set.has` per
    // session and no I/O, so it is safe on a route polled every 2 s per device.
    const attention = sessionAttentionSignals({
      newVulnerabilities: vulnerabilitySessions.attention.get(session.sessionId),
      projectId: session.projectId,
      disconnectedSandboxProjects:
        deps.provisioner?.disconnectedSandboxProjects?.() ?? NO_DISCONNECTED_SANDBOXES,
    });
    return {
      ...session,
      status,
      ...(AWAITING.has(status) && sessionHasOpenTasks(events) ? { backgroundWorking: true } : {}),
      pendingPermissions,
      ...(status === 'awaiting_input' && pendingPermissions.length > 0
        ? { permissionAwaitingInput: true as const }
        : {}),
      // Both absent in the common case, so a quiet session's summary is unchanged.
      ...(pendingPermissionRequests.length > 0 ? { pendingPermissionRequests } : {}),
      ...(openChoices !== undefined ? { openChoices } : {}),
      // Summed in SQL over the whole log rather than folded out of `events`: the
      // slice is on its way to being a bounded tail, and a total taken from a
      // tail would quietly shrink as a session got longer.
      usage: facts.usage,
      lastActivityAt: facts.lastActivityAt,
      ...(rateLimit ? { rateLimit } : {}),
      ...(rateLimits.length > 0 ? { rateLimits } : {}),
      resumable,
      ...(branch !== undefined ? { branch } : {}),
      eventCount: facts.eventCount,
      agentTextCounterVersion: 'agent-text-v2',
      // Omit entirely when unresolved/unconfigured (exactOptionalPropertyTypes): a
      // literal `undefined` isn't assignable to `pr?: … | null`, and absent reads as
      // "no marker" on the client anyway.
      ...(pr !== undefined ? { pr } : {}),
      ...(pullRequest !== undefined ? { pullRequest } : {}),
      // Absent when healthy, so a healthy session's summary is byte-identical to
      // what it was before this existed.
      ...(attention.length > 0 ? { attention } : {}),
      ...(automationStatus !== undefined ? { automation: { status: automationStatus } } : {}),
    };
  };

  return {
    prunePrSummaryCache,
    pruneBranchCache,
    liveStatus,
    prSummaryCache,
    compactPr,
    applyPrSummaryAction,
    sessionPrCache,
    sessionPrStatus,
    summarizeSessions,
    emptyProjectionFacts,
    projectionEventsFor,
    latestRateLimitsFromSequenced,
    liveStatusFromProjection,
    sessionResumable,
    activityBusyCache,
    activityLogBusy,
    AWAITING,
    branchesForSession,
    currentBranchCached,
    summarizeSession,
    readBranchMetadata,
    localMergeTarget,
    prCleanupPending,
    withPrVisibility,
    invalidatePrSummaryAction,
    invalidateBranchCache,
  };
}
