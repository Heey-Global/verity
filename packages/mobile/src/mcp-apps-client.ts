import { z } from 'zod';

export function mcpAppsClient(
  request: (path: string, init: RequestInit) => Promise<Response>,
  baseUrl: () => string,
) {
  const path = (sessionId: string, appId: string) =>
    `/sessions/${encodeURIComponent(sessionId)}/mcp-apps/${encodeURIComponent(appId)}`;
  return {
    async getMcpAppDocument(
      this: void,
      sessionId: string,
      appId: string,
      signal?: AbortSignal,
    ): Promise<string> {
      const response = await request(path(sessionId, appId), {
        method: 'GET',
        ...(signal ? { signal } : {}),
      });
      return z.object({ document: z.string() }).parse(await response.json()).document;
    },
    async createMcpAppDocumentUrl(
      this: void,
      sessionId: string,
      appId: string,
      signal?: AbortSignal,
    ): Promise<string> {
      const response = await request(`${path(sessionId, appId)}/document`, {
        method: 'POST',
        ...(signal ? { signal } : {}),
      });
      const document = z
        .object({ path: z.string().regex(/^\/mcp-app-document\?ticket=[A-Za-z0-9_-]{43}$/) })
        .parse(await response.json());
      return `${baseUrl()}${document.path}`;
    },
    async callMcpAppTool(
      this: void,
      sessionId: string,
      appId: string,
      call: { name: string; arguments?: Record<string, unknown> },
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      const response = await request(`${path(sessionId, appId)}/call`, {
        method: 'POST',
        body: JSON.stringify(call),
        ...(signal ? { signal } : {}),
      });
      return z.record(z.string(), z.unknown()).parse(await response.json());
    },
  };
}
