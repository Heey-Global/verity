import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  connectionFingerprint,
  listAppTools,
  mcpAppsCapabilities,
  mcpRpc,
  object,
  uiMetadata,
  visibleTo,
  type McpAppEvent,
  type McpRpc,
} from './mcp-apps.js';
import { forwardHttpMcp, type HttpMcpProxyDeps } from './http-mcp-proxy.js';

const paramsSchema = z.object({ id: z.string().min(1), appId: z.string().uuid() });
const callSchema = z
  .object({
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

function domains(value: unknown): string {
  if (value === undefined) return '';
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid MCP Apps CSP');
  return value
    .map((domain: unknown) => {
      if (typeof domain !== 'string') throw new Error('Invalid CSP domain');
      const url = new URL(domain);
      if (url.protocol !== 'https:' || url.username || url.password || url.origin !== domain)
        throw new Error('Invalid CSP domain');
      return url.origin;
    })
    .join(' ');
}

/** Put the policy before all untrusted HTML; subsequent policies can only restrict it. */
export function appDocument(html: string, resourceMeta: unknown): string {
  const csp = object(object(object(resourceMeta).ui).csp);
  const resources = domains(csp.resourceDomains);
  const connections = domains(csp.connectDomains);
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: ${resources}; font-src ${resources || "'none'"}; media-src ${resources || "'none'"}; connect-src ${connections || "'none'"}; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none';`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

export interface McpAppsRouteDeps {
  resolveConnection: HttpMcpProxyDeps['resolveConnection'];
  getProjectId(sessionId: string): Promise<string | undefined>;
  getApp(sessionId: string, appId: string): Promise<McpAppEvent | undefined>;
  emit(sessionId: string, event: McpAppEvent): Promise<void>;
  approve(input: {
    sessionId: string;
    callId: string;
    toolName: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<boolean>;
  settled(sessionId: string, callId: string): Promise<void>;
  rpc?: McpRpc;
  closeSession?: (connection: Parameters<McpRpc>[0], sessionId: string) => Promise<void>;
}

export function registerMcpAppsRoutes(app: FastifyInstance, deps: McpAppsRouteDeps): void {
  const rpc = deps.rpc ?? mcpRpc;
  const pending = new Set<string>();
  const resolve = async (sessionId: string, appId: string) => {
    const projectId = await deps.getProjectId(sessionId);
    if (projectId === undefined) return undefined;
    const event = await deps.getApp(sessionId, appId);
    if (event === undefined || event.projectId !== projectId || event.sessionId !== sessionId)
      return undefined;
    const connection = await deps.resolveConnection({
      projectId,
      connectionId: event.connectionId,
    });
    if (
      connection === undefined ||
      connectionFingerprint(connection) !== event.connectionFingerprint
    )
      return undefined;
    return { event, connection };
  };
  const withSession = async <T>(
    connection: Parameters<McpRpc>[0],
    action: (sessionId: string | undefined, protocolVersion: string) => Promise<T>,
  ) => {
    const initialized = await rpc(connection, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { extensions: mcpAppsCapabilities },
      clientInfo: { name: 'Verity MCP Apps', version: '1.0.0' },
    });
    const protocolVersion =
      typeof initialized.result.protocolVersion === 'string'
        ? initialized.result.protocolVersion
        : '2025-11-25';
    try {
      await rpc(
        connection,
        'notifications/initialized',
        {},
        initialized.sessionId,
        protocolVersion,
      );
      return await action(initialized.sessionId, protocolVersion);
    } finally {
      if (initialized.sessionId !== undefined) {
        const close =
          deps.closeSession ??
          (async (target, sessionId) => {
            const response = await forwardHttpMcp(target, 'DELETE', undefined, {
              sessionId,
              protocolVersion,
            });
            response.body.destroy();
          });
        await close(connection, initialized.sessionId).catch(() => undefined);
      }
    }
  };
  app.get('/sessions/:id/mcp-apps/:appId', async (request, reply) => {
    const { id, appId } = paramsSchema.parse(request.params);
    const resolved = await resolve(id, appId);
    if (resolved === undefined) return reply.code(404).send({ error: 'MCP app unavailable' });
    try {
      return await withSession(resolved.connection, async (sessionId, version) => {
        const { result } = await rpc(
          resolved.connection,
          'resources/read',
          { uri: resolved.event.resourceUri },
          sessionId,
          version,
        );
        const resource = Array.isArray(result.contents)
          ? result.contents
              .map(object)
              .find(
                (entry) =>
                  entry.uri === resolved.event.resourceUri &&
                  entry.mimeType === 'text/html;profile=mcp-app',
              )
          : undefined;
        if (resource === undefined || typeof resource.text !== 'string')
          throw new Error('Missing MCP app HTML');
        if ((await resolve(id, appId)) === undefined)
          return reply.code(404).send({ error: 'MCP app unavailable' });
        return { document: appDocument(resource.text, resource._meta) };
      });
    } catch {
      return reply.code(502).send({ error: 'Could not load MCP app' });
    }
  });
  app.post(
    '/sessions/:id/mcp-apps/:appId/call',
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const { id, appId } = paramsSchema.parse(request.params);
      const call = callSchema.parse(request.body);
      const resolved = await resolve(id, appId);
      if (resolved === undefined) return reply.code(404).send({ error: 'MCP app unavailable' });
      if (pending.has(id) || pending.size >= 64)
        return reply.code(409).send({ error: 'An app action is already pending' });
      pending.add(id);
      const signal = AbortSignal.timeout(120_000);
      let permissionId: string | undefined;
      try {
        return await withSession(resolved.connection, async (sessionId, version) => {
          const tools = await listAppTools(rpc, resolved.connection, sessionId, version);
          const tool = tools.find((candidate) => candidate.name === call.name);
          const ownerTool = tools.find((candidate) => candidate.name === resolved.event.toolName);
          if (
            tool === undefined ||
            !visibleTo(tool, 'app') ||
            uiMetadata(ownerTool ?? {}).resourceUri !== resolved.event.resourceUri
          )
            return reply.code(403).send({ error: 'Tool unavailable to this app' });
          permissionId = randomUUID();
          const allowed = await deps.approve({
            sessionId: id,
            callId: permissionId,
            toolName: `mcp_app:${resolved.event.connectionId}:${call.name}`,
            input: { appId, tool: call.name, arguments: call.arguments },
            signal,
          });
          if (!allowed || signal.aborted)
            return reply.code(403).send({ error: 'MCP app action denied' });
          if ((await resolve(id, appId)) === undefined)
            return reply.code(404).send({ error: 'MCP app access changed' });
          const currentTools = await listAppTools(rpc, resolved.connection, sessionId, version);
          const currentTool = currentTools.find((candidate) => candidate.name === call.name);
          const currentOwner = currentTools.find(
            (candidate) => candidate.name === resolved.event.toolName,
          );
          if (
            currentTool === undefined ||
            !visibleTo(currentTool, 'app') ||
            uiMetadata(currentOwner ?? {}).resourceUri !== resolved.event.resourceUri
          )
            return reply.code(403).send({ error: 'Tool access changed' });
          const { result } = await rpc(resolved.connection, 'tools/call', call, sessionId, version);
          if ((await resolve(id, appId)) === undefined)
            return reply.code(404).send({ error: 'MCP app access changed' });
          if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
            throw new Error('MCP app result too large');
          await deps.emit(id, { ...resolved.event, result });
          return result;
        });
      } catch {
        return reply.code(502).send({ error: 'MCP app action failed' });
      } finally {
        pending.delete(id);
        if (permissionId !== undefined) await deps.settled(id, permissionId);
      }
    },
  );
}
