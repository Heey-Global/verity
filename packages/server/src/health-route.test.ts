import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHealthRoute } from './health-route.js';

describe('GET /healthz public preview availability', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('reflects Uplink admission changes after route registration', async () => {
    let available = false;
    const app = Fastify();
    apps.push(app);
    registerHealthRoute(app, {
      version: 'test',
      pushEnabled: false,
      publicPreviewsEnabled: () => available,
    });

    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      publicPreviewsEnabled: false,
    });

    available = true;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      publicPreviewsEnabled: true,
    });

    available = false;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      publicPreviewsEnabled: false,
    });
  });
});
