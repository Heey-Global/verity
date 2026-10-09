import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthTokenRegistry } from './auth.js';
import { registerServerUpdateRoutes } from './server-update-routes.js';
import { UpdaterRequestError } from './self-update/updater-status.js';

describe('Server update channel routes', () => {
  it('requires pairing, accepts only known channels and relays busy operations', async () => {
    const app = Fastify();
    let enabled = false;
    const setChannel = vi.fn(async () => 'staging' as const);
    registerServerUpdateRoutes(app, {
      authRegistry: { isEnabled: () => enabled } as AuthTokenRegistry,
      serverUpdateController: {
        readOperation: async () => null,
        requestUpdate: vi.fn(),
        readChannel: async () => 'stable',
        setChannel,
      },
    });
    expect((await app.inject({ method: 'GET', url: '/server/update-channel' })).json()).toEqual({
      channel: 'stable',
    });
    const change = (channel: string) =>
      app.inject({ method: 'POST', url: '/server/update-channel', payload: { channel } });
    expect((await change('staging')).statusCode).toBe(403);
    expect(setChannel).not.toHaveBeenCalled();
    enabled = true;
    expect((await change('beta')).statusCode).toBe(400);
    expect(setChannel).not.toHaveBeenCalled();
    expect((await change('staging')).json()).toEqual({ channel: 'staging' });
    expect(setChannel).toHaveBeenCalledWith('staging');
    setChannel.mockRejectedValueOnce(new UpdaterRequestError(409, 'operation-in-progress'));
    expect((await change('stable')).statusCode).toBe(409);
    await app.close();
  });
});
