import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bearerToken } from './auth.js';
import { internalConnectionIdentity, requestArrivedInternally } from './internal-listener.js';
import type { McpGateway } from './mcp-gateway.js';

export interface McpGatewayRouteDeps {
  gateway: McpGateway;
  controlProjectId: string;
}

/** Registers the project-bound and control-plane MCP gateway transports. */
export function registerMcpGatewayRoutes(app: FastifyInstance, deps: McpGatewayRouteDeps): void {
  app.post(
    '/internal/mcp',
    // The server-wide limit is ~71 MiB so a turn can carry image attachments. A gateway
    // call is a JSON-RPC envelope around tool arguments — an HTTP request the operator is
    // expected to read on a card — so it needs a small fraction of that, and the tool's
    // `body` is otherwise unbounded JSON that a parked card persists as a permission
    // event. 256 KiB fits any request worth approving by hand and keeps a caller holding
    // a valid bearer from making the Server buffer and store tens of MB per call.
    { bodyLimit: 256 * 1024 },
    async (request, reply): Promise<unknown> => {
      const socketIdentity = internalConnectionIdentity(request);
      if (socketIdentity === undefined) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const presented = bearerToken(request.headers.authorization);
      const response = await deps.gateway.handle({
        projectId: socketIdentity.projectId,
        token: presented,
        body: request.body,
      });
      reply.code(response.status);
      // MCP acknowledges a notification with an empty 202. Returning undefined from an
      // async handler leaves the reply unsent and returning null writes the four bytes
      // `null`, so send the empty payload explicitly and hand Fastify the reply itself.
      return response.body === undefined ? reply.send() : response.body;
    },
  );

  // The Streamable HTTP transport opens this stream after its handshake. The gateway has
  // no server-initiated messages, and 405 is the protocol-compatible way to say so.
  app.get('/internal/mcp', async (request, reply): Promise<unknown> => {
    if (internalConnectionIdentity(request) === undefined) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    reply.code(405).header('allow', 'POST');
    return { error: 'method_not_allowed' };
  });

  // The control-plane runner has no project socket. It must arrive on the shared internal
  // listener without a project identity; its per-turn bearer remains the authorization.
  const controlPlaneConnection = (request: FastifyRequest): boolean =>
    requestArrivedInternally(request) && internalConnectionIdentity(request) === undefined;
  app.post(
    '/internal/control-plane/mcp',
    { bodyLimit: 256 * 1024 },
    async (request, reply): Promise<unknown> => {
      if (!controlPlaneConnection(request)) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const presented = bearerToken(request.headers.authorization);
      const response = await deps.gateway.handle({
        projectId: deps.controlProjectId,
        token: presented,
        body: request.body,
      });
      reply.code(response.status);
      return response.body === undefined ? reply.send() : response.body;
    },
  );

  app.get('/internal/control-plane/mcp', async (request, reply): Promise<unknown> => {
    if (!controlPlaneConnection(request)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    reply.code(405).header('allow', 'POST');
    return { error: 'method_not_allowed' };
  });
}
