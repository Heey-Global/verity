import { randomUUID, createHash } from 'node:crypto';
import type { AgentEvent } from '@verity/events';
import type { HttpMcpProxyConnection, HttpMcpProxyDeps } from './http-mcp-proxy.js';
import { forwardHttpMcp } from './http-mcp-proxy.js';
import { transformMcpResponse } from './mcp-apps-stream.js';

export type McpAppEvent = Extract<AgentEvent, { t: 'mcp_app' }>;
export type McpRpc = (
  connection: HttpMcpProxyConnection,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  protocolVersion?: string,
) => Promise<{ result: Record<string, unknown>; sessionId?: string }>;

export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const mcpAppsCapabilities = {
  'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
};

export function connectionFingerprint(connection: HttpMcpProxyConnection): string {
  return createHash('sha256')
    .update(connection.url)
    .update('\0')
    .update(connection.authorization ?? '')
    .digest('hex');
}

/** Uses the same public-HTTPS/DNS validation and bounded streams as agent traffic. */
export const mcpRpc: McpRpc = async (connection, method, params, sessionId, protocolVersion) => {
  const id = randomUUID();
  const notification = method.startsWith('notifications/');
  const response = await forwardHttpMcp(
    connection,
    'POST',
    Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    ),
    {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    },
  );
  if (notification && response.status >= 200 && response.status < 300) {
    response.body.destroy();
    return { result: {}, ...(sessionId === undefined ? {} : { sessionId }) };
  }
  if (response.status !== 200) {
    response.body.destroy();
    throw new Error('MCP request failed');
  }
  let result: Record<string, unknown> | undefined;
  let bytes = 0;
  const source = async function* () {
    for await (const chunk of response.body) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error('MCP app response too large');
      yield chunk as Buffer;
    }
  };
  try {
    for await (const chunk of transformMcpResponse(source(), response.eventStream, (message) => {
      const envelope = object(message);
      if (envelope.id === id) {
        if (envelope.error !== undefined) throw new Error('MCP RPC failed');
        result = object(envelope.result);
      }
      return Promise.resolve(message);
    })) {
      if (chunk.length > 0 && result !== undefined) break;
    }
  } finally {
    response.body.destroy();
  }
  if (result === undefined) throw new Error('MCP response missing');
  const nextSession = response.headers['mcp-session-id'] ?? sessionId;
  return { result, ...(nextSession === undefined ? {} : { sessionId: nextSession }) };
};

export async function listAppTools(
  rpc: McpRpc,
  connection: HttpMcpProxyConnection,
  sessionId?: string,
  protocolVersion?: string,
): Promise<Record<string, unknown>[]> {
  const tools: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const { result } = await rpc(
      connection,
      'tools/list',
      cursor === undefined ? {} : { cursor },
      sessionId,
      protocolVersion,
    );
    if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tool list');
    tools.push(...result.tools.map(object));
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor) || seen.size >= 32) throw new Error('MCP tool pagination limit');
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

export function uiMetadata(tool: Record<string, unknown>): Record<string, unknown> {
  return object(object(tool._meta).ui);
}

export function visibleTo(tool: Record<string, unknown>, target: 'model' | 'app'): boolean {
  const visibility = uiMetadata(tool).visibility;
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes(target));
}

export function createMcpAppsInterceptor(deps: {
  emit(sessionId: string, event: McpAppEvent): Promise<void>;
  rpc?: McpRpc;
  onError?: (error: unknown) => void;
}): NonNullable<HttpMcpProxyDeps['intercept']> {
  const rpc = deps.rpc ?? mcpRpc;
  const pending = new Map<
    string,
    { createdAt: number; capture: (result: Record<string, unknown>) => Promise<void> }
  >();
  return async ({ projectId, caller, connection, body, protocolSessionId, protocolVersion }) => {
    const request = object(body);
    const params = object(request.params);
    const key = (id: unknown) =>
      JSON.stringify([
        projectId,
        caller.sessionId,
        caller.turnId,
        connection.id,
        protocolSessionId ?? '',
        typeof id,
        id,
      ]);
    for (const [pendingKey, entry] of pending) {
      if (Date.now() - entry.createdAt > 8 * 60 * 60_000) pending.delete(pendingKey);
    }
    if (request.method === 'tools/call') {
      const tool = (await listAppTools(rpc, connection, protocolSessionId, protocolVersion)).find(
        (candidate) => candidate.name === params.name,
      );
      if (tool === undefined || !visibleTo(tool, 'model'))
        throw new Error('MCP tool is not model-visible');
      const uri = uiMetadata(tool).resourceUri;
      if (
        typeof uri === 'string' &&
        uri.startsWith('ui://') &&
        uri.length <= 2048 &&
        (typeof request.id === 'string' || typeof request.id === 'number')
      ) {
        if (pending.size >= 1024 || pending.has(key(request.id)))
          throw new Error('MCP app invocation limit');
        const appId = randomUUID();
        pending.set(key(request.id), {
          createdAt: Date.now(),
          capture: async (result) => {
            const event: McpAppEvent = {
              t: 'mcp_app',
              appId,
              projectId,
              sessionId: caller.sessionId,
              turnId: caller.turnId,
              connectionId: connection.id,
              connectionFingerprint: connectionFingerprint(connection),
              toolName: String(params.name),
              resourceUri: uri,
              input: object(params.arguments),
              result,
            };
            try {
              if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024)
                throw new Error('MCP app data too large');
              await deps.emit(caller.sessionId, event);
            } catch (error) {
              // The tool already ran: keep its text result usable if its optional UI cannot be stored.
              deps.onError?.(error);
            }
          },
        });
      }
    }
    const prepared =
      request.method === 'initialize'
        ? {
            ...request,
            params: {
              ...params,
              capabilities: {
                ...object(params.capabilities),
                extensions: {
                  ...object(object(params.capabilities).extensions),
                  ...mcpAppsCapabilities,
                },
              },
            },
          }
        : body;
    return {
      body: prepared,
      transform: async (message) => {
        const envelope = object(message);
        if (
          envelope.id === undefined ||
          (envelope.result === undefined && envelope.error === undefined)
        )
          return message;
        const entry = pending.get(key(envelope.id));
        if (entry !== undefined) {
          pending.delete(key(envelope.id));
          if (envelope.result !== undefined) await entry.capture(object(envelope.result));
        }
        if (envelope.result === undefined) return message;
        const result = object(envelope.result);
        if (Array.isArray(result.tools))
          return {
            ...envelope,
            result: {
              ...result,
              tools: result.tools.filter((candidate) => visibleTo(object(candidate), 'model')),
            },
          };
        if (
          entry !== undefined ||
          Array.isArray(result.content) ||
          result.structuredContent !== undefined
        ) {
          const modelResult = { ...result };
          delete modelResult._meta;
          return { ...envelope, result: modelResult };
        }
        return message;
      },
    };
  };
}
