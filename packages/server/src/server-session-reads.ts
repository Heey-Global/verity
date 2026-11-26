import { registerAttachmentRoute } from './attachment-route.js';
import { hiddenSessionIds } from './hidden-sessions.js';
import type { FastifyInstance } from 'fastify';
import {
  attentionSignals,
  type AttentionSignal,
  type SecretStatus,
  type UpdaterProbe,
} from './attention.js';
import type { CodexUsageHealth, CodexUsageService } from './codexUsage.js';
import { registerMessageSearchRoute } from './message-search-route.js';
import { filterModelListForProject } from './project-agent-policy.js';
import type { ServerContext } from './server-context.js';
import type { peopleDirectQueries, sharedProjectPeople } from './server-people.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import {
  DEFAULT_HISTORY_PAGE,
  isProjectSessionModel,
  PROJECTION_TAIL,
  projectSettingsStore,
  redactScrollDiagnosticData,
  redactScrollDiagnosticEvent,
} from './server-support.js';
import type { SessionDetail } from './server-types.js';
import type { ServerUpdateController } from './server-update-routes.js';
import { sessionGoogleStatus } from './session-google-status.js';
import { parseScrollDiagnostic, registerSessionHistoryRoutes } from './session-history-routes.js';
import { registerSessionListRoute } from './session-list-route.js';
import { recentSessionDiagnostics } from './session-observation.js';
import { registerSessionOrderRoute } from './session-order-route.js';
import { registerSessionReadRoutes } from './session-read-routes.js';
import { permissionEventAwaitsInput } from './status.js';

type SessionOverview = ReturnType<typeof createServerSessionOverview>;
type SharedProjectPeople = ReturnType<typeof sharedProjectPeople>;
type HasMeetingJob = (sessionId: string) => boolean;

/** Closures `buildServer` still owns that the session list depends on. */
export interface SessionListWiring {
  codexUsage: Pick<CodexUsageService, 'health'>;
  wikiMaintenanceSessions: Set<string>;
  sessionOverview: Pick<
    SessionOverview,
    'prunePrSummaryCache' | 'pruneBranchCache' | 'summarizeSessions' | 'sessionPrCache'
  >;
}

/**
 * The session list with its order, the attention signals it carries, and
 * message search. Returns the secret-store status reader, which the secret
 * routes share so the banner and `GET /secret/status` never disagree.
 */
export function installSessionList(
  app: FastifyInstance,
  ctx: ServerContext,
  { codexUsage, wikiMaintenanceSessions, sessionOverview }: SessionListWiring,
): { readSecretStatus: () => Promise<SecretStatus> } {
  const { deps } = ctx;
  const { prunePrSummaryCache, pruneBranchCache, summarizeSessions } = sessionOverview;
  // Project list / status badges + token totals — a read-time projection over
  // each session's event log, served through `summarizeSessions` so the whole
  // list costs a fixed number of queries over the narrow projection slice rather
  // than one full-log hydration per session.
  /**
   * The at-rest-encryption state, as `GET /secret/status` reports it. Shared
   * with the attention probe below so the two can never disagree about what
   * "sealed" means — the whole point of the banner is that it says the same
   * thing the status endpoint would have.
   *
   * Costs nothing on a healthy Server: `isSealed()` is in memory and the store
   * is only consulted once the answer is already "sealed".
   */
  const readSecretStatus = async (): Promise<SecretStatus> => {
    const cipher = deps.secretCipher;
    if (cipher === undefined) return 'unmanaged';
    if (!cipher.isSealed()) return 'unlocked';
    const meta = await deps.eventStore.getSecretKeyMeta();
    return meta === undefined ? 'uninitialized' : 'sealed';
  };

  /**
   * The Updater's state, cached, and refreshed OFF the request path.
   *
   * This is the one part of the attention probe that costs a round trip — over
   * the Updater's Unix control socket, whose request timeout is
   * `UPDATER_REQUEST_TIMEOUT_MS` (2 s). The session list is polled every 2 s per
   * device, so probing inline would (a) put 30 socket calls a minute per device
   * on the Updater and (b), far worse, make a HUNG Updater add up to two seconds
   * to every session-list response. A health signal that degrades the screen it
   * rides on is not worth having.
   *
   * So: a request reads the last known answer and never waits for a new one. The
   * refresh is single-flighted and only the very first call awaits it, because
   * only that one has nothing to report yet. The conditions this detects last
   * minutes or hours; a snapshot up to {@link UPDATER_PROBE_TTL_MS} old costs
   * nothing in fidelity.
   */
  const UPDATER_PROBE_TTL_MS = 15_000;
  let updaterProbe: UpdaterProbe | undefined;
  let updaterProbedAt = 0;
  let updaterProbeInFlight: Promise<void> | undefined;
  const refreshUpdaterProbe = (controller: ServerUpdateController): Promise<void> => {
    updaterProbeInFlight ??= controller
      .readOperation()
      .then(
        (operation) => ({ kind: 'reachable' as const, operation }),
        (): UpdaterProbe => ({ kind: 'unreachable' as const }),
      )
      .then((probe) => {
        updaterProbe = probe;
        updaterProbedAt = Date.now();
      })
      .finally(() => {
        updaterProbeInFlight = undefined;
      });
    return updaterProbeInFlight;
  };

  /**
   * Server-level conditions worth interrupting the operator for, computed from
   * what `/secret/status` and `/server/updates` already know. Never throws: a
   * failure to probe must not take the session list down with it, so an
   * unreadable probe degrades to "nothing to report" for that one condition.
   */
  let codexHealthReadFailed = false;
  const collectAttention = async (): Promise<AttentionSignal[]> => {
    const secretStatus = await readSecretStatus().catch((): SecretStatus => 'unmanaged');
    const controller = deps.serverUpdateController;
    let updater: UpdaterProbe = { kind: 'unmanaged' };
    if (controller !== undefined) {
      const refresh =
        Date.now() - updaterProbedAt >= UPDATER_PROBE_TTL_MS
          ? refreshUpdaterProbe(controller)
          : undefined;
      if (updaterProbe === undefined) await refresh;
      updater = updaterProbe ?? { kind: 'unmanaged' };
    }
    // Read, never probed: `health()` reports what the last quota refresh already
    // learned, so the list poll cannot be slowed or broken by the usage endpoint.
    // Caught anyway — an injected probe is somebody else's code, and this file
    // promises attention can never be the reason `/sessions` fails.
    let usage: CodexUsageHealth | undefined;
    try {
      const read: unknown = codexUsage.health();
      // Shape-checked, not just try/caught: an injected probe that returns null
      // satisfies no type at runtime, and `attentionSignals` would throw on it
      // OUTSIDE this guard — taking the session list down by the one path this
      // block exists to close.
      usage = typeof read === 'object' && read !== null ? (read as CodexUsageHealth) : undefined;
      // Cleared on the way out, so the latch is once per OUTAGE rather than once
      // per process: a second, unrelated failure months later still gets a warning.
      codexHealthReadFailed = false;
    } catch (err) {
      // Warned once, then quiet: this runs on a 2 s poll per device, and every
      // other failure path in the probe is rate-limited by its own backoff.
      if (codexHealthReadFailed) app.log.debug({ err }, 'verity: codex usage health read failed');
      else app.log.warn({ err }, 'verity: codex usage health read failed; omitting from attention');
      codexHealthReadFailed = true;
    }
    return attentionSignals({ secretStatus, updater, codexUsage: usage, now: Date.now() });
  };

  registerSessionOrderRoute(app, { store: deps.eventStore });
  registerSessionListRoute(app, {
    store: deps.eventStore,
    visibleTo: async (viewer) => {
      if (await deps.eventStore.isActiveAdministrator(viewer)) return { all: true };
      return {
        all: false,
        projectIds: new Set(await deps.eventStore.listReadableProjectIds(viewer)),
        unassigned: false,
      };
    },
    requestAddressing: { store: deps.eventStore },
    changeSubmissions: {
      store: deps.eventStore,
      pullRequest: (session) => sessionOverview.sessionPrCache.get(session),
    },
    prunePrSummaryCache,
    pruneBranchCache,
    summarizeSessions,
    collectAttention,
    hiddenSessionIds: hiddenSessionIds(deps.eventStore, wikiMaintenanceSessions),
  });

  registerMessageSearchRoute(app, { eventStore: deps.eventStore });
  return { readSecretStatus };
}

/** Closures `buildServer` still owns that the session reads depend on. */
export interface SessionReadsWiring {
  hasMeetingJob: HasMeetingJob;
  sessionOverview: Pick<
    SessionOverview,
    | 'emptyProjectionFacts'
    | 'projectionEventsFor'
    | 'latestRateLimitsFromSequenced'
    | 'liveStatusFromProjection'
    | 'sessionResumable'
  >;
  availableModels: Parameters<typeof peopleDirectQueries>[1];
  personSessionModel: SharedProjectPeople['personSessionModel'];
  projectPeopleNames: SharedProjectPeople['projectPeopleNames'];
}

/** One session's detail and the models offered for a session. */
export function installSessionReads(
  app: FastifyInstance,
  ctx: ServerContext,
  {
    hasMeetingJob,
    sessionOverview,
    availableModels,
    personSessionModel,
    projectPeopleNames,
  }: SessionReadsWiring,
): void {
  const { deps, conductor } = ctx;
  const {
    emptyProjectionFacts,
    projectionEventsFor,
    latestRateLimitsFromSequenced,
    liveStatusFromProjection,
    sessionResumable,
  } = sessionOverview;
  registerSessionReadRoutes(app, {
    getGoogleStatus: async (id, viewer) =>
      (await deps.eventStore.getSession(id))
        ? sessionGoogleStatus(deps.eventStore, id, viewer)
        : undefined,
    listModels: async (projectId, viewer) => {
      const available = await availableModels({ viewer });
      if (projectId === undefined) return available;
      const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(projectId);
      // The default offered is the person's own for this project, within its agent rule.
      const own =
        viewer === undefined
          ? null
          : await deps.eventStore.userProviderConnections.projectDefaultModel(viewer, projectId);
      return filterModelListForProject(
        available,
        settings === undefined || settings === null ? settings : { ...settings, defaultModel: own },
        isProjectSessionModel,
      );
    },
    getSession: async (id, viewer): Promise<SessionDetail | undefined> => {
      const session = await deps.eventStore.getSession(id);
      if (!session) return undefined;
      await conductor.refreshDetachedPermissions?.(id);
      // Opening a session hits this route first, and the transcript arrives over a
      // separate paged read — so hydrating the whole log here bought nothing but
      // latency in front of the first paint. The header's status, usage,
      // rate-limit and count fields all come out of the projection slice.
      const facts =
        (await deps.eventStore.listSessionProjectionFacts([id], PROJECTION_TAIL)).get(id) ??
        emptyProjectionFacts();
      const events = await projectionEventsFor(id, facts);
      // As in `summarizeSessionWithFacts`: the quota states come from their own
      // read, because the newest one for a window can predate any tail.
      const rateLimits = latestRateLimitsFromSequenced(facts.rateLimitEvents);
      const rateLimit = rateLimits[0];
      const pendingLinks = (await deps.eventStore.pendingSessionLinkMessageIds([id])).get(id) ?? [];
      const pendingPermissions = [
        ...new Set([...conductor.pendingPermissions(id), ...pendingLinks]),
      ];
      // Status needs log presence independently of the filtered unread count.
      const projectedStatus = liveStatusFromProjection(
        id,
        events,
        facts.lastEventSeq === 0 ? 0 : 1,
      );
      const status =
        pendingPermissions.length > 0
          ? 'awaiting_input'
          : projectedStatus === 'awaiting_input' &&
              permissionEventAwaitsInput(events) &&
              pendingPermissions.length === 0
            ? conductor.isBusy(id, { turnOnly: true })
              ? 'running'
              : 'completed'
            : projectedStatus;
      const ownModel = await personSessionModel(session, viewer);
      const people = await projectPeopleNames(session.projectId);
      return {
        ...session,
        // In a shared session the composer shows the viewer's own model, and each
        // message can be labelled with its sender's name.
        ...(ownModel === undefined ? {} : { model: ownModel }),
        ...(people === undefined ? {} : { people, viewerUserId: viewer }),
        ...(await deps.eventStore.viewState.sessionView(viewer, id)),
        googleStatus: await sessionGoogleStatus(deps.eventStore, id, viewer ?? undefined),
        status,
        pendingPermissions,
        pendingPermissionRequests: conductor.detachedPermissionRequests?.(id) ?? [],
        ...(status === 'awaiting_input' && pendingPermissions.length > 0
          ? { permissionAwaitingInput: true as const }
          : {}),
        usage: facts.usage,
        ...(rateLimit ? { rateLimit } : {}),
        ...(rateLimits.length > 0 ? { rateLimits } : {}),
        resumable: await sessionResumable(session),
        eventCount: facts.eventCount,
        agentTextCounterVersion: 'agent-text-v2',
        lastActivityAt: facts.lastActivityAt,
        lastMessageAt: facts.lastMessageAt,
        busy: conductor.isBusy(id) || hasMeetingJob(id),
        queued: conductor.queuedItems(id),
      };
    },
  });
}

/** Closures `buildServer` still owns that the session history depends on. */
export interface SessionHistoryWiring {
  hasMeetingJob: HasMeetingJob;
  sessionOverview: Pick<
    SessionOverview,
    | 'activityBusyCache'
    | 'activityLogBusy'
    | 'AWAITING'
    | 'branchesForSession'
    | 'currentBranchCached'
  >;
}

/** A session's live activity, history pages, diagnostics and scroll reports. */
export function installSessionHistory(
  app: FastifyInstance,
  ctx: ServerContext,
  { hasMeetingJob, sessionOverview }: SessionHistoryWiring,
): void {
  const { deps, conductor } = ctx;
  const { activityBusyCache, activityLogBusy, AWAITING, branchesForSession, currentBranchCached } =
    sessionOverview;
  // Lightweight live activity for a session, polled by the app for the "working"
  // indicator + persistent "waiting" messages. `busy` = the conductor is in-flight
  // OR the event log still derives `running` (an open background task — sub-agent /
  // `run_in_background` — the conductor stopped tracking once its turn settled, e.g.
  // a crashed/non-live backend between re-invocations). The `isBusy` term is kept
  // FIRST and un-suppressed so a turn parked on a permission prompt (`awaiting_input`,
  // still in-flight) stays busy, and — because `||` short-circuits — the hot
  // actively-working path never pays the event-log read. It also carries the
  // worktree's live branch (#110) so the header label auto-updates on an
  // external/agent `git checkout`; both reads are best-effort — on any failure the
  // poll falls back to raw `isBusy` and omits name/branch, never a 500.
  app.register((instance, _opts, done) => {
    registerSessionHistoryRoutes(instance, {
      activity: async (reply, id) => {
        await conductor.refreshDetachedPermissions?.(id);
        const pendingLinks =
          (await deps.eventStore.pendingSessionLinkMessageIds([id])).get(id) ?? [];
        const base = {
          busy: conductor.isBusy(id) || hasMeetingJob(id),
          queued: conductor.queuedItems(id),
          pendingPermissions: [...new Set([...conductor.pendingPermissions(id), ...pendingLinks])],
          pendingPermissionRequests: conductor.detachedPermissionRequests?.(id) ?? [],
          modelSwitchPending:
            conductor.hasDeferredAfterCurrentTurn(id) || conductor.isBackendHandoffPending(id),
          // Busy for a reason the operator cannot see otherwise: a stop that could not
          // establish the worker exited keeps the session RESERVED (nothing is running
          // for them) until termination is confirmed. Without this the state is
          // indistinguishable from an endlessly working turn.
          terminationUnconfirmed: conductor.hasUnconfirmedTermination(id),
        };
        try {
          const session = await deps.eventStore.getSession(id);
          if (!session) {
            activityBusyCache.delete(id);
            reply.code(404);
            return { error: `session ${id} not found` };
          }
          // In-flight OR log-derived running (open background task). The cached
          // projection also separates input waits from active background work. Carry
          // the display name so the header reflects an auto-generated (or externally
          // renamed) title within a poll, without a remount. `branch` is still gated on
          // the branch-switching dep (a git read).
          // The durable mutation marker gates projection hydration. An unchanged
          // log reuses its pure busy result; live conductor fields above and the
          // session's metadata and branch below still update on every poll.
          //
          // Log hydration exists specifically for a background task that outlived
          // conductor tracking. Neutral notices (including meeting progress) are
          // not turns and must not make an otherwise-finished session busy forever.
          const log = await activityLogBusy(id);
          const busy = base.busy || log.busy;
          const awaiting =
            base.pendingPermissions.length > 0 ||
            (AWAITING.has(log.status) && !log.waitingPermission);
          const activityAnimating =
            busy && !base.terminationUnconfirmed && (!awaiting || log.openTasks);
          const branches = await branchesForSession(session);
          const branch = branches
            ? await currentBranchCached(branches, session.worktree)
            : undefined;
          return {
            ...base,
            busy,
            activityAnimating,
            name: session.name,
            ...(branch !== undefined ? { branch } : {}),
            // Polled with the rest so the planning bar follows an agent that starts
            // planning mid-turn, not only the operator's own taps.
            ...(session.planning !== undefined ? { planning: session.planning } : {}),
            planningRevision: session.planningRevision,
            planningPlan: session.planningPlan,
            // The status bar follows the review the same way, including decisions
            // made on another device.
            mockupReview: session.mockupReview ?? null,
          };
        } catch {
          return base; // unknown session / git hiccup → raw isBusy, omit name+branch, keep the poll alive
        }
      },
      recordScrollDiagnostic: async (reply, id, body) => {
        const session = await deps.eventStore.getSession(id);
        if (!session) {
          reply.code(404);
          return { error: `session ${id} not found` };
        }
        const diagnostic = parseScrollDiagnostic(body);
        app.log.info(
          {
            sessionId: id,
            projectId: session.projectId,
            scroll: {
              event: redactScrollDiagnosticEvent(diagnostic.event),
              seq: diagnostic.seq,
              at: diagnostic.at,
              data: redactScrollDiagnosticData(diagnostic.data),
            },
          },
          'verity: mobile scroll diagnostic',
        );
        return { ok: true };
      },
      // Backward-paginated history: the newest `limit` events with seq < `beforeSeq`
      // (omit for the most recent page), ascending, plus `hasMore`. Lets the app open
      // a long session with only its tail and fetch older turns on scroll-up, instead
      // of replaying the whole event log. Live updates still arrive over the WS stream.
      boundedHistory: async (reply, id, beforeSeq, snapshotSeq, eventOffset) => {
        if (!(await deps.eventStore.getSession(id))) {
          reply.code(404);
          return { error: `session ${id} not found` };
        }
        try {
          return await deps.eventStore.getBoundedHistory(id, beforeSeq, snapshotSeq, eventOffset);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          reply.code(400);
          return { error: 'invalid history offset' };
        }
      },
      history: async (reply, id, limit, beforeSeq) => {
        const session = await deps.eventStore.getSession(id);
        if (!session) {
          reply.code(404);
          return { error: `session ${id} not found` };
        }
        return deps.eventStore.getEventsBeforeSeq(id, limit ?? DEFAULT_HISTORY_PAGE, beforeSeq);
      },
      diagnostics: async (reply, id) => {
        const session = await deps.eventStore.getSession(id);
        if (!session) {
          reply.code(404);
          return { error: `session ${id} not found` };
        }
        // Diagnostics are scalar metadata only; the transcript and raw agent output
        // never cross this endpoint.
        const diagnostics = [];
        let beforeSeq: number | undefined;
        // A sparse or older session may have no diagnostics at all. Bound the
        // backward scan independently of the number of matches.
        for (let pageNumber = 0; pageNumber < 10 && diagnostics.length < 100; pageNumber += 1) {
          const page = await deps.eventStore.getEventsBeforeSeq(id, 500, beforeSeq);
          diagnostics.unshift(...recentSessionDiagnostics(page.events, 100));
          if (!page.hasMore || page.events.length === 0) break;
          beforeSeq = page.events[0]?.seq;
        }
        return diagnostics.slice(-100);
      },
    });
    done();
  });
}

export function installSessionAttachments(app: FastifyInstance, ctx: ServerContext): void {
  // Serve a content-addressed image attachment by its SHA-256 hash. The `prompt`
  // event references images by this id; the client fetches them lazily (only the
  // visible ones), so opening a session never transfers the whole image backlog.
  // Content-addressed → the bytes for a given id never change, so it's cached
  // forever (immutable). 404 for an unknown hash.
  registerAttachmentRoute(app, {
    getAttachment: (hash, maxBytes) => ctx.deps.eventStore.getAttachment(hash, maxBytes),
  });
}
