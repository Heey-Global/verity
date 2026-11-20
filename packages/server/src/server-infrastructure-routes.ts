import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import { SERVER_VERSION } from './server-support.js';
import { createBackupAlertNotifier } from './backup/alert-notifier.js';
import { registerBackupRoutes } from './backup/routes.js';
import { registerHealthRoute } from './health-route.js';
import { installRemoteControl } from './server-remote-control.js';
import { registerDiagnosticsMemoryRoute } from './diagnostics-memory-route.js';
import { registerLogRoutes } from './log-routes.js';
import { registerAuditRoutes } from './audit-routes.js';
import { registerServerUpdateRoutes } from './server-update-routes.js';
import { registerPushTokenRoute } from './push-token-route.js';

export function installInfrastructureRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { deps, lifecycle, pushSender } = ctx;
  if (deps.backup) {
    lifecycle.onClose(() => deps.backup!.close());
    deps.backup.service?.setAlertNotifier(createBackupAlertNotifier(deps.eventStore, pushSender));
    app.addHook('onReady', (done) => {
      deps.backup!.service?.start();
      done();
    });
  }
  registerBackupRoutes(app, {
    userId: (request) => request.localUserId,
    isAdministrator: (userId) => deps.eventStore.isActiveAdministrator(userId),
    service: deps.backup?.service,
    unavailableReason: () => deps.backup?.unavailableReason ?? 'installer-required',
  });
  registerHealthRoute(app, {
    version: SERVER_VERSION,
    pushEnabled: deps.pushEnabled === true,
    publicPreviewsEnabled: () => deps.previewShareManager?.isAvailable() === true,
    ...(deps.secretJobRuntimeReadiness !== undefined
      ? { secretJobRuntimeReadiness: deps.secretJobRuntimeReadiness }
      : {}),
  });
  installRemoteControl(app, ctx);
  registerDiagnosticsMemoryRoute(app);
  if (deps.audit !== undefined) {
    registerLogRoutes(app, { ...deps.audit, runtimeDiagnostics: deps.runtimeDiagnostics });
    registerAuditRoutes(app, {
      ...deps.audit,
      sessionName: async (sessionId) => (await deps.eventStore.getSession(sessionId))?.name ?? null,
    });
  }

  registerServerUpdateRoutes(app, deps);

  registerPushTokenRoute(app, {
    store: deps.eventStore,
    ...(deps.authRegistry !== undefined ? { authRegistry: deps.authRegistry } : {}),
    ...(deps.pushEnabled !== undefined ? { pushEnabled: deps.pushEnabled } : {}),
  });
}
