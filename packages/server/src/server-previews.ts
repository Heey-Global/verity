import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import {
  registerManagedDevServerAgentRoute,
  registerManagedDevServerRoutes,
} from './managed-dev-server-routes.js';
import { registerProjectDnsRoute } from './project-dns-route.js';
import { registerLocalPreviewRoutes } from './local-preview-routes.js';
import { registerPreviewShareRoutes } from './preview-share-routes.js';

export function installPreviews(app: FastifyInstance, ctx: ServerContext): void {
  const { deps } = ctx;
  registerManagedDevServerRoutes(app, { manager: deps.managedDevServerManager });
  registerProjectDnsRoute(app, { resolveDirect: deps.projectEgressResolve });
  registerManagedDevServerAgentRoute(app, {
    manager: deps.managedDevServerManager,
    capabilities: deps.ghTokenCapabilities,
    eventStore: deps.eventStore,
  });
  registerLocalPreviewRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.localPreviewManager ? { manager: deps.localPreviewManager } : {}),
    ...(deps.previewSharingCapability ? { publicSharing: deps.previewSharingCapability } : {}),
  });
  registerPreviewShareRoutes(app, {
    eventStore: deps.eventStore,
    ...(deps.listenerDiscovery ? { listenerDiscovery: deps.listenerDiscovery } : {}),
    ...(deps.localPreviewManager ? { localManager: deps.localPreviewManager } : {}),
    ...(deps.previewShareManager ? { manager: deps.previewShareManager } : {}),
  });
}
