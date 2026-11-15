import type { FastifyInstance } from 'fastify';
import { requestCredential } from './auth.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { registerPairingRoutes } from './pairing-routes.js';
import type { ServerContext } from './server-context.js';
import type { SpawnSession } from './session-create-route.js';
import { registerWebAppRoutes } from './web-app.js';
import { registerWelcomeRoutes } from './welcome-session.js';

/**
 * First run and device access: the web app, device pairing, the onboarding
 * status the app polls before unlock, and the welcome session. Installed after
 * the session routes, whose spawn the welcome session uses.
 */
export function installOnboarding(
  app: FastifyInstance,
  ctx: ServerContext,
  { spawn }: { spawn: SpawnSession },
): void {
  const { deps, liveHub } = ctx;
  registerWebAppRoutes(app, deps.webAppDir);
  registerPairingRoutes(app, {
    browserRequestOrigin: deps.browserRequestOrigin,
    ...(deps.devicePairing !== undefined ? { devicePairing: deps.devicePairing } : {}),
    ...(deps.authRegistry !== undefined ? { authRegistry: deps.authRegistry } : {}),
  });

  // ── First-run onboarding gate (#320) ──────────────────────────────────────
  // `GET /onboarding/status` — the pre-unlock gate the app polls on launch. Uses
  // ONLY non-decrypting reads so it answers while the store is sealed.
  registerOnboardingRoutes(app, {
    eventStore: deps.eventStore,
    secretCipher: deps.secretCipher,
    isAuthenticated: (request) =>
      deps.authRegistry === undefined ||
      deps.authRegistry.verify(requestCredential(request)) === true,
  });

  // First-run welcome session in the starter project (see welcome-session.ts).
  // Created through the same spawn path as POST /sessions; the session-route
  // live hint does not fire for this URL, so it is sent here.
  registerWelcomeRoutes(app, {
    eventStore: deps.eventStore,
    secretCipher: deps.secretCipher,
    spawn,
    notifySessionCreated: (sessionId, projectId) =>
      liveHub.notify({ sessionId, projectId, topics: ['session', 'status'] }),
  });
}
