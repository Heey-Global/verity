import type { FastifyInstance } from 'fastify';
import { registerHttpMcpConnectionRoutes } from './http-mcp-connections-route.js';
import { installNetworkShares } from './network-share-routes.js';
import { SmbClient } from './network-share-smb.js';
import { registerProjectEgressRoutes } from './project-egress-routes.js';
import type { ServerContext } from './server-context.js';

export function installConnections(app: FastifyInstance, ctx: ServerContext): void {
  registerHttpMcpConnectionRoutes(app, ctx.deps.eventStore, {
    browserRequestOrigin: ctx.deps.browserRequestOrigin,
  });
  registerProjectEgressRoutes(app, ctx.deps.eventStore.projectEgress);
  installNetworkShares(app, {
    store: ctx.deps.eventStore,
    client: ctx.deps.networkShareClient ?? new SmbClient(),
    isSealed: () => ctx.deps.secretCipher?.isSealed() === true,
  });
}
