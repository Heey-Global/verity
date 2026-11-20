import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken } from './auth.js';
import {
  internalConnectionIdentity,
  internalConnectionGenerationSignal,
  requestArrivedInternally,
} from './internal-listener.js';
import type { McpGateway } from './mcp-gateway.js';

export interface McpGatewayRouteDeps {
  gateway: McpGateway;
  controlProjectId: string;
}

/** A closed app stream is unrelated to this connection: only the tool caller's
 * disconnect cancels the held request, so leaving the app does not deny approval. */
async function withCallerCancellation(
  request: FastifyRequest,
  reply: FastifyReply,
  serve: (signal: AbortSignal) => ReturnType<McpGateway['handle']>,
): ReturnType<McpGateway['handle']> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Tool caller disconnected.'));
  const close = (): void => {
    if (!reply.raw.writableFinished) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    return await serve(controller.signal);
  } finally {
    request.raw.off('aborted', abort);
    reply.raw.off('close', close);
  }
}

/** Registers the project-bound and control-plane MCP gateway transports. */
export function registerMcpGatewayRoutes(app: FastifyInstance, deps: McpGatewayRouteDeps): void {
  app.post(
    '/internal/mcp',
    // A 256 KiB Markdown document can expand sixfold under JSON escaping. Bound
    // the transport envelope separately; the knowledge store enforces UTF-8 bytes.
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply): Promise<unknown> => {
      const socketIdentity = internalConnectionIdentity(request);
      if (socketIdentity === undefined) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const signal = internalConnectionGenerationSignal(request);
      const presented = bearerToken(request.headers.authorization);
      const response = await withCallerCancellation(request, reply, (callerSignal) =>
        deps.gateway.handle({
          projectId: socketIdentity.projectId,
          token: presented,
          body: request.body,
          signal: callerSignal,
          ...(signal === undefined ? {} : { transport: { identity: socketIdentity, signal } }),
        }),
      );
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
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply): Promise<unknown> => {
      if (!controlPlaneConnection(request)) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const presented = bearerToken(request.headers.authorization);
      const response = await withCallerCancellation(request, reply, (signal) =>
        deps.gateway.handle({
          projectId: deps.controlProjectId,
          token: presented,
          body: request.body,
          signal,
        }),
      );
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
