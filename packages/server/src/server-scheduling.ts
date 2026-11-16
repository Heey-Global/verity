import type { FastifyInstance } from 'fastify';
import { PreviewConnector } from '@verity/preview-tunnel';
import type { ServerContext } from './server-context.js';
import type { PushFirePoints } from './push-fire-points.js';
import type { PushRouter } from './push-router.js';
import { SchedulingPageListeners } from './scheduling-page.js';
import { registerSchedulingRoutes } from './scheduling-routes.js';
import { startSchedulingScheduler, type SchedulingScheduler } from './scheduling-scheduler.js';
import { SchedulingService } from './scheduling-service.js';
import {
  assistantNoticeTarget,
  schedulingNoticeText,
  schedulingPush,
} from './scheduling-notices.js';
import { createSchedulingTool } from './scheduling-tool.js';
import { emitNotice } from './session-event-writer.js';

interface SchedulingOptions {
  pushRouter: PushRouter | undefined;
  pushFirePoints: PushFirePoints | undefined;
}

// Register on the shared root so scheduling uses the same request hooks and
// route-scope tracking as the rest of the server.
export function createServerScheduling(
  app: FastifyInstance,
  ctx: ServerContext,
  { pushRouter, pushFirePoints }: SchedulingOptions,
): { schedulingTool: ReturnType<typeof createSchedulingTool> } {
  const { deps, lifecycle } = ctx;
  // Scheduling requests run on their own once approved: the service owns holds, the public
  // booking links (one Uplink share and loopback page each) and cleanup; the scheduler resumes
  // all of it from durable state after a restart.
  let schedulingScheduler: SchedulingScheduler | undefined;
  const schedulingPages: SchedulingPageListeners = new SchedulingPageListeners({
    view: (id) => schedulingService.view(id),
    book: (id, start, note) => schedulingService.book(id, start, note),
    publicOrigin: async (id) => (await deps.eventStore.scheduling.share(id))?.publicOrigin,
  });
  const schedulingService: SchedulingService = new SchedulingService({
    store: deps.eventStore,
    googleAccessToken: deps.googleAccessToken ?? (() => Promise.resolve(undefined)),
    edge: deps.attendeeEdge,
    listen: schedulingPages.listen,
    unlisten: schedulingPages.unlisten,
    connect: async (binding, targetOrigin) => {
      const connector = new PreviewConnector({
        edgeUrl: binding.edgeUrl,
        connectorToken: binding.connectorToken,
        targetOrigin,
        maxBodyBytes: 65_536,
        requestTimeoutMs: 25_000,
      });
      await connector.connect();
      return connector;
    },
    notify: async (notification) => {
      const sessionId = notification.request.sessionId;
      try {
        await emitNotice({
          eventStore: deps.eventStore,
          bus: deps.bus,
          sessionId,
          text: schedulingNoticeText(notification),
        });
      } catch (err) {
        app.log.warn({ err, sessionId }, 'scheduling notice failed');
      }
      try {
        const assistant = await assistantNoticeTarget(deps.eventStore, notification.request);
        if (assistant)
          await emitNotice({
            eventStore: deps.eventStore,
            bus: deps.bus,
            sessionId: assistant.sessionId,
            text: `${assistant.prefix}${schedulingNoticeText(notification)}`,
          });
      } catch (err) {
        app.log.warn({ err, sessionId }, 'assistant scheduling notice failed');
      }
      const push = schedulingPush(notification);
      if (push && pushRouter)
        try {
          await pushRouter.notify({
            key: `scheduling:${notification.request.id}:${notification.kind}`,
            sessionId,
            initiatorUserId: await pushFirePoints?.initiatorOf(sessionId),
            notification: push,
          });
        } catch (err) {
          app.log.warn({ err, sessionId }, 'scheduling push failed');
        }
    },
    wake: () => schedulingScheduler?.wake(),
  });
  registerSchedulingRoutes(app, { eventStore: deps.eventStore, service: schedulingService });
  app.addHook('onReady', () => {
    schedulingScheduler = startSchedulingScheduler({
      runDue: () => schedulingService.runDue(),
      log: app.log,
    });
  });
  lifecycle.onClose(async () => {
    await schedulingScheduler?.stop();
    schedulingService.close();
    await schedulingPages.close();
  });
  const schedulingTool = createSchedulingTool({
    store: deps.eventStore,
    service: () => schedulingService,
  });
  return { schedulingTool };
}
