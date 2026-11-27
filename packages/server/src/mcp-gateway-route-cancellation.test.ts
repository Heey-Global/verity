import Fastify from 'fastify';
import { request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';

import { registerMcpGatewayRoutes } from './mcp-gateway-route.js';

vi.mock('./internal-listener.js', () => ({
  internalConnectionIdentity: (request: { url: string }) =>
    request.url === '/internal/mcp' ? { projectId: 'p1', containerGeneration: 'g1' } : undefined,
  internalConnectionGenerationSignal: () => undefined,
  requestArrivedInternally: () => true,
}));

it.each(['/internal/mcp', '/internal/control-plane/mcp'])(
  'cancels the held tool request when its caller disconnects from %s',
  async (url) => {
    const app = Fastify();
    let received!: () => void;
    let cancellation!: AbortSignal;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    registerMcpGatewayRoutes(app, {
      controlProjectId: 'control',
      gateway: {
        handle: async ({ signal }) => {
          cancellation = signal!;
          received();
          await new Promise<void>((resolve) =>
            signal!.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { status: 200, body: {} };
        },
      },
    });
    try {
      await app.ready();
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      const caller = request({
        host: '127.0.0.1',
        port: (app.server.address() as AddressInfo).port,
        method: 'POST',
        path: url,
        headers: { 'content-type': 'application/json' },
      });
      caller.on('error', () => undefined);
      caller.end('{}');
      await arrived;
      expect(cancellation.aborted).toBe(false);
      caller.destroy();
      await vi.waitFor(() => expect(cancellation.aborted).toBe(true));
    } finally {
      await app.close();
    }
  },
);
