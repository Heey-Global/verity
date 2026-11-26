import { performance } from 'node:perf_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRequestLatencyTrace, withRequestLatencyTrace } from '@verity/store';
import type { McpGateway } from './mcp-gateway.js';

type McpGatewayResponse = Awaited<ReturnType<McpGateway['handle']>>;

/** A gateway call slower than this is logged at `warn`, like the slow read diagnostic. */
export const SLOW_GATEWAY_CALL_MS = 3_000;
const TOOL_NAME_LOG_LIMIT = 100;

/** The tool a `tools/call` envelope names, bounded for logging; `undefined` for anything else. */
function calledToolName(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== 'tools/call') return undefined;
  const name =
    params !== null && typeof params === 'object' ? (params as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name.slice(0, TOOL_NAME_LOG_LIMIT) : 'unnamed';
}

/** A JSON-RPC error, or a tool result the gateway marked as failed. */
function responseFailed(response: McpGatewayResponse): boolean {
  const body = response.body as { error?: unknown; result?: { isError?: unknown } } | undefined;
  return response.status >= 400 || body?.error !== undefined || body?.result?.isError === true;
}

/**
 * Serve one gateway POST and, when it is a tool call, log which tool it was, how long it
 * took and how much of that went to waiting for a database connection.
 *
 * Fastify writes `request completed` only when the response finishes. A caller that times
 * out and disconnects first leaves no completion line at all, even when the handler finishes
 * later, so a slow call and a call that never returns look the same in the request log. The
 * `started` line ties a request id to its tool; the `finished` line is written however the
 * call ends and says whether the caller was still there to receive it.
 *
 * The call runs in its own latency trace because a POST handler does not reliably inherit
 * the one opened in `onRequest`: body parsing resumes outside it. The trace's owner also
 * names the tool in the pool-holder samples other slow requests log.
 */
export async function serveLoggedGatewayCall(
  request: FastifyRequest,
  reply: FastifyReply,
  serve: () => Promise<McpGatewayResponse>,
): Promise<McpGatewayResponse> {
  const toolName = calledToolName(request.body);
  if (toolName === undefined) return serve();
  const trace = createRequestLatencyTrace();
  trace.owner = `${request.method} ${request.routeOptions.url ?? 'unmatched'} ${toolName} (${request.id})`;
  const started = performance.now();
  request.log.info({ toolName }, 'mcp gateway tool call started');
  let outcome: 'result' | 'error' | 'thrown' = 'thrown';
  try {
    const response = await withRequestLatencyTrace(trace, serve);
    outcome = responseFailed(response) ? 'error' : 'result';
    return response;
  } finally {
    const elapsedMs = performance.now() - started;
    const callerDisconnected = reply.raw.destroyed;
    // `poolAcquire.holders` is sampled only once a checkout has waited a second, and names
    // what held the connections this call was queued behind.
    const entry = {
      toolName,
      outcome,
      elapsedMs,
      callerDisconnected,
      poolAcquire: trace.poolAcquire,
      queries: trace.queries,
    };
    if (elapsedMs >= SLOW_GATEWAY_CALL_MS || callerDisconnected) {
      request.log.warn(entry, 'mcp gateway tool call finished');
    } else {
      request.log.info(entry, 'mcp gateway tool call finished');
    }
  }
}
