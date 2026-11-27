import { createMcpAppDocumentTickets } from './mcp-apps-tickets.js';
import { randomUUID } from 'node:crypto';
import './fastify-augmentation.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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

/** Calls of one session run one at a time; later calls wait instead of failing. */
const MAX_QUEUED_PER_SESSION = 8;
const MAX_ACTIVE_SESSIONS = 64;
const QUEUE_WAIT_MS = 120_000;
const SETTLE_WAIT_MS = 5_000;
/** How long one approval covers repeated calls of the same read-only tool from one app card. */
export const READ_ONLY_GRANT_MS = 30 * 60_000;
const MAX_GRANTS = 4096;

/** The server's own declaration; write tools and undeclared tools always ask again. */
const readOnly = (tool: Record<string, unknown>) => object(tool.annotations).readOnlyHint === true;

/**
 * One lane per session: an app call holds it from approval to result. Waiting calls are
 * bounded per session and in total, and give up after their deadline.
 */
function createCallLanes() {
  const lanes = new Map<string, { tail: Promise<void>; size: number }>();
  return {
    async acquire(
      sessionId: string,
      signal: AbortSignal,
    ): Promise<(() => void) | 'full' | 'gave_up'> {
      let lane = lanes.get(sessionId);
      if (lane === undefined) {
        if (lanes.size >= MAX_ACTIVE_SESSIONS) return 'full';
        lane = { tail: Promise.resolve(), size: 0 };
        lanes.set(sessionId, lane);
      }
      if (lane.size >= MAX_QUEUED_PER_SESSION) return 'full';
      const current = lane;
      current.size++;
      let open!: () => void;
      const mine = new Promise<void>((resolve) => (open = resolve));
      const previous = current.tail;
      // A caller that gives up still lets its successors wait for everything before it.
      current.tail = previous.then(() => mine);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        open();
        current.size--;
        if (current.size === 0 && lanes.get(sessionId) === current) lanes.delete(sessionId);
      };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<false>((resolve) => {
        onAbort = () => resolve(false);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const ready = await Promise.race([previous.then(() => true as const), aborted]);
      signal.removeEventListener('abort', onAbort!);
      if (!ready) {
        release();
        return 'gave_up';
      }
      return release;
    },
  };
}

/** Approvals of read-only tools, scoped to one person, one app card and one tool. */
function createReadOnlyGrants(now: () => number) {
  const grants = new Map<string, number>();
  const key = (sessionId: string, appId: string, userId: string | undefined, tool: string) =>
    JSON.stringify([sessionId, appId, userId, tool]);
  return {
    covers: (...args: Parameters<typeof key>) => (grants.get(key(...args)) ?? 0) > now(),
    grant(...args: Parameters<typeof key>) {
      const k = key(...args);
      for (const [other, expires] of grants) if (expires <= now()) grants.delete(other);
      // Re-insert so the oldest entry really is the first one evicted.
      grants.delete(k);
      if (grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value!);
      grants.set(k, now() + READ_ONLY_GRANT_MS);
    },
    revoke: (...args: Parameters<typeof key>) => grants.delete(key(...args)),
    clear: () => grants.clear(),
  };
}

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
  const policy = appDocumentPolicy(resourceMeta);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

function appDocumentPolicy(resourceMeta: unknown): string {
  const csp = object(object(object(resourceMeta).ui).csp);
  const resources = domains(csp.resourceDomains);
  const connections = domains(csp.connectDomains);
  return `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: ${resources}; font-src ${resources || "'none'"}; media-src ${resources || "'none'"}; connect-src ${connections || "'none'"}; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none';`;
}

export interface McpAppsRouteDeps {
  authorizeRequest(request: FastifyRequest): Promise<boolean>;
  captureDocumentAccess(request: FastifyRequest): () => Promise<boolean>;
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
  now?: () => number;
}

export function registerMcpAppsRoutes(app: FastifyInstance, deps: McpAppsRouteDeps): void {
  const rpc = deps.rpc ?? mcpRpc;
  const lanes = createCallLanes();
  const grants = createReadOnlyGrants(deps.now ?? Date.now);
  const tickets = createMcpAppDocumentTickets();
  app.addHook('onClose', (_instance, done) => {
    tickets.clear();
    grants.clear();
    done();
  });
  // An app runs on the connection of the person using it, not of whoever's turn
  // rendered it: another member opening it must not act with that turn's account.
  const resolve = async (sessionId: string, appId: string, userId: string | undefined) => {
    const projectId = await deps.getProjectId(sessionId);
    if (projectId === undefined) return undefined;
    const event = await deps.getApp(sessionId, appId);
    if (event === undefined || event.projectId !== projectId || event.sessionId !== sessionId)
      return undefined;
    const connection = await deps.resolveConnection({
      projectId,
      connectionId: event.connectionId,
      principal: { userId },
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
  const loadDocument = async (id: string, appId: string, userId: string | undefined) => {
    const resolved = await resolve(id, appId, userId);
    if (!resolved) return undefined;
    return withSession(resolved.connection, async (sessionId, version) => {
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
      if (!resource || typeof resource.text !== 'string') throw new Error('Missing MCP app HTML');
      if (!(await resolve(id, appId, userId))) return undefined;
      return {
        document: appDocument(resource.text, resource._meta),
        policy: appDocumentPolicy(resource._meta),
      };
    });
  };
  app.get('/sessions/:id/mcp-apps/:appId', async (request, reply) => {
    const { id, appId } = paramsSchema.parse(request.params);
    try {
      const loaded = await loadDocument(id, appId, request.localUserId ?? undefined);
      if (!loaded) return reply.code(404).send({ error: 'MCP app unavailable' });
      return { document: loaded.document };
    } catch {
      return reply.code(502).send({ error: 'Could not load MCP app' });
    }
  });
  app.post('/sessions/:id/mcp-apps/:appId/document', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id, appId } = paramsSchema.parse(request.params);
    if (!(await deps.authorizeRequest(request)))
      return reply.code(403).send({ error: 'MCP app access denied' });
    const userId = request.localUserId ?? undefined;
    if (!(await resolve(id, appId, userId)))
      return reply.code(404).send({ error: 'MCP app unavailable' });
    const ticket = tickets.mint({
      sessionId: id,
      appId,
      userId,
      authorized: deps.captureDocumentAccess(request),
    });
    return { path: `/mcp-app-document?ticket=${ticket}` };
  });
  // This fixed route authenticates only its single-use document capability.
  app.get('/mcp-app-document', { exposeHeadRoute: false }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    const query = z
      .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .safeParse(request.query);
    const access = query.success ? tickets.consume(query.data.ticket) : undefined;
    if (!access || !(await access.authorized()))
      return reply.code(404).send({ error: 'MCP app unavailable' });
    try {
      const loaded = await loadDocument(access.sessionId, access.appId, access.userId);
      if (!loaded || !(await access.authorized()))
        return reply.code(404).send({ error: 'MCP app unavailable' });
      // The response sandbox also isolates direct top-level navigation.
      reply.header(
        'Content-Security-Policy',
        `${loaded.policy} sandbox allow-scripts; frame-ancestors 'self';`,
      );
      return reply.type('text/html; charset=utf-8').send(loaded.document);
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
      const resolved = await resolve(id, appId, request.localUserId ?? undefined);
      if (resolved === undefined) return reply.code(404).send({ error: 'MCP app unavailable' });
      // A caller that went away must not raise an approval card or run its call later.
      const gone = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const release = await lanes.acquire(
        id,
        AbortSignal.any([AbortSignal.timeout(QUEUE_WAIT_MS), gone.signal]),
      );
      if (release === 'full')
        return reply.code(409).send({ error: 'Too many app actions are waiting' });
      if (release === 'gave_up')
        return reply.code(409).send({ error: 'Earlier app actions did not finish in time' });
      const signal = AbortSignal.any([AbortSignal.timeout(120_000), gone.signal]);
      const userId = request.localUserId ?? undefined;
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
          // Without a known person there is nobody to scope the grant to: always ask.
          const repeatable = readOnly(tool) && userId !== undefined;
          const granted = repeatable && grants.covers(id, appId, userId, call.name);
          if (!granted) {
            permissionId = randomUUID();
            const allowed = await deps.approve({
              sessionId: id,
              callId: permissionId,
              toolName: `mcp_app:${resolved.event.connectionId}:${call.name}`,
              input: {
                appId,
                tool: call.name,
                arguments: call.arguments,
                // Shown on the approval card, so the scope of the answer is visible.
                ...(repeatable
                  ? {
                      approvalCovers: `Further calls of this tool, which the server declares read-only, with any arguments, from this app for ${READ_ONLY_GRANT_MS / 60_000} minutes`,
                    }
                  : {}),
              },
              signal,
            });
            if (!allowed || signal.aborted)
              return reply.code(403).send({ error: 'MCP app action denied' });
          }
          if ((await resolve(id, appId, userId)) === undefined) {
            grants.revoke(id, appId, userId, call.name);
            return reply.code(404).send({ error: 'MCP app access changed' });
          }
          const currentTools = await listAppTools(rpc, resolved.connection, sessionId, version);
          const currentTool = currentTools.find((candidate) => candidate.name === call.name);
          const currentOwner = currentTools.find(
            (candidate) => candidate.name === resolved.event.toolName,
          );
          if (
            currentTool === undefined ||
            !visibleTo(currentTool, 'app') ||
            uiMetadata(currentOwner ?? {}).resourceUri !== resolved.event.resourceUri ||
            (repeatable && !readOnly(currentTool))
          ) {
            grants.revoke(id, appId, userId, call.name);
            return reply.code(403).send({ error: 'Tool access changed' });
          }
          // Approval can outlive the caller's login or project execute grant.
          if (!(await deps.authorizeRequest(request))) {
            grants.revoke(id, appId, userId, call.name);
            return reply.code(403).send({ error: 'MCP app access changed' });
          }
          if (gone.signal.aborted) return reply.code(409).send({ error: 'Caller went away' });
          if (repeatable && !granted) grants.grant(id, appId, userId, call.name);
          const { result } = await rpc(resolved.connection, 'tools/call', call, sessionId, version);
          if ((await resolve(id, appId, userId)) === undefined) {
            grants.revoke(id, appId, userId, call.name);
            return reply.code(404).send({ error: 'MCP app access changed' });
          }
          if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
            throw new Error('MCP app result too large');
          await deps.emit(id, { ...resolved.event, result });
          return result;
        });
      } catch {
        return reply.code(502).send({ error: 'MCP app action failed' });
      } finally {
        // The lane covers the approval's settlement too, so the next call asks only after it,
        // but a stuck settlement must not block the session's later calls for good.
        try {
          if (permissionId !== undefined)
            await Promise.race([
              deps.settled(id, permissionId),
              new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS).unref()),
            ]);
        } finally {
          release();
        }
      }
    },
  );
}
