import type { FastifyInstance } from 'fastify';
import type { SessionRecord } from '@verity/store';
import type { PushSessionContext } from './pr-ready-push.js';
import { createPushFirePoints, type PushFirePoints } from './push-fire-points.js';
import { createPushRouter, type PushRouter } from './push-router.js';
import { createServerUpdateNotifier } from './self-update/server-update-notifier.js';
import type { ServerDeps } from './server-deps.js';
import type { ServerContext } from './server-context.js';

export function createServerPush(app: FastifyInstance, deps: ServerDeps) {
  const pushSender =
    typeof deps.pushSender === 'function' ? deps.pushSender(app.log) : deps.pushSender;
  const describePushSession = async (session: SessionRecord): Promise<PushSessionContext> => {
    const project = session.projectId
      ? await deps.eventStore.getProject(session.projectId).catch(() => undefined)
      : undefined;
    return {
      ...(project ? { project: `${project.owner}/${project.repo}` } : {}),
      session: session.name?.trim() || `Session ${session.sessionId.slice(0, 8)}`,
    };
  };
  const describePushSessionById = async (sessionId: string): Promise<PushSessionContext> => {
    const session = await deps.eventStore.getSession(sessionId);
    return session ? describePushSession(session) : {};
  };
  return { pushSender, describePushSession, describePushSessionById };
}

export function createServerPushRuntime(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: {
    describePushSessionById: (sessionId: string) => Promise<PushSessionContext>;
  },
) {
  const { deps, lifecycle, liveHub, pushSender } = ctx;
  const { describePushSessionById } = wiring;
  const pushRouter: PushRouter | undefined =
    pushSender === undefined
      ? undefined
      : createPushRouter({
          sender: pushSender,
          presence: liveHub,
          store: deps.eventStore,
          logger: app.log,
          ...(deps.pushEscalationMs === undefined ? {} : { escalationMs: deps.pushEscalationMs }),
        });
  lifecycle.onClose(() => {
    pushRouter?.close();
  });
  const pushFirePoints: PushFirePoints | undefined =
    pushRouter === undefined
      ? undefined
      : createPushFirePoints({
          router: pushRouter,
          logger: app.log,
          describeSession: describePushSessionById,
          getEvents: (sessionId) => deps.eventStore.getEvents(sessionId),
          ...(deps.pushFirePointDebounceMs === undefined
            ? {}
            : { debounceMs: deps.pushFirePointDebounceMs }),
        });
  // Wiki maintenance runs in a quiet session per project that no list shows and
  // that never notifies anyone; its results surface only as proposals to review.
  // Filled from the store when the server is ready and as sessions are created.
  const wikiMaintenanceSessions = new Set<string>();
  const unsubscribePushFirePoints =
    pushFirePoints === undefined
      ? undefined
      : deps.bus.subscribeAll((sessionId, event) => {
          if (!wikiMaintenanceSessions.has(sessionId)) pushFirePoints.observe(sessionId, event);
        });
  return { pushRouter, pushFirePoints, wikiMaintenanceSessions, unsubscribePushFirePoints };
}

export function startServerPush(app: FastifyInstance, ctx: ServerContext) {
  const { deps, pushSender } = ctx;
  // Built here rather than in `embedded.ts` because this is where the single
  // long-lived PushSender exists: a second instance would poll Expo receipts in
  // parallel with this one, and the notifier needs delivery, not its own fleet.
  //
  // Absent without push (nothing to announce with), without a resolver (nothing
  // to announce), without a controller (`POST /server/updates` answers 503, so the
  // announcement would name an action this deployment cannot perform — the same
  // mistake as announcing `incompatible`), or without a state path — see the dep's
  // own note for why the last one disables it rather than defaulting.
  const updateResolver = deps.serverUpdateResolver;
  const updateController = deps.serverUpdateController;
  const notifierStatePath = deps.serverUpdateNotifierStatePath;
  const serverUpdateNotifier =
    pushSender === undefined ||
    updateResolver === undefined ||
    updateController === undefined ||
    notifierStatePath === undefined
      ? undefined
      : createServerUpdateNotifier({
          resolve: () => updateResolver.resolve(),
          // The same overlay `GET /server/updates` applies: availability alone
          // reports no operation, so without this the notifier would announce a
          // release while that release is being installed.
          readOperation: () => updateController.readOperation(),
          notify: (notification) => pushSender.send(notification),
          statePath: notifierStatePath,
          log: (message, error) =>
            error === undefined ? app.log.info(message) : app.log.warn({ err: error }, message),
        });
  pushSender?.start();
  serverUpdateNotifier?.start();
  return serverUpdateNotifier;
}

export function registerPushShutdown(
  ctx: ServerContext,
  wiring: {
    unsubscribePushFirePoints: (() => void) | undefined;
    serverUpdateNotifier: ReturnType<typeof startServerPush>;
    pushFirePoints: PushFirePoints | undefined;
    stopVulnerabilityPush: () => Promise<void>;
  },
): void {
  const { lifecycle, pushSender } = ctx;
  const { unsubscribePushFirePoints, serverUpdateNotifier, pushFirePoints, stopVulnerabilityPush } =
    wiring;
  lifecycle.onClose(async () => {
    unsubscribePushFirePoints?.();
    // Awaited, and before the sender it pushes through: a check still in flight
    // would otherwise resolve the channel and send into a closing PushSender.
    await serverUpdateNotifier?.close();
    await pushFirePoints?.close();
    await stopVulnerabilityPush();
    await pushSender?.close();
  });
}
