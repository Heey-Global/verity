import type { FastifyInstance } from 'fastify';
import { registerHttpMcpConnectionRoutes } from './http-mcp-connections-route.js';
import { registerProjectEgressRoutes } from './project-egress-routes.js';
import type { ServerContext } from './server-context.js';

export function installConnections(app: FastifyInstance, ctx: ServerContext): void {
  registerHttpMcpConnectionRoutes(app, ctx.deps.eventStore, {
    browserRequestOrigin: ctx.deps.browserRequestOrigin,
  });
  registerProjectEgressRoutes(app, ctx.deps.eventStore.projectEgress);
}
