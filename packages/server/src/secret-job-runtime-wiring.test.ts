import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { EmbeddedServer } from './embedded.js';
import { buildTestEmbeddedServer } from './testing.js';
import { PINNED_RUNSC_ARGS, PINNED_RUNSC_PATH } from './gvisor-runtime-config.js';

describe('Secret Job Executor runtime readiness wiring', () => {
  let docker: Server;
  let dockerBaseUrl: string;
  let runtimePath = PINNED_RUNSC_PATH;
  let malformedRuntime = false;
  let infoRequests = 0;
  let embedded: EmbeddedServer | undefined;

  beforeAll(async () => {
    docker = createServer((request, response) => {
      if (request.url !== '/info') {
        response.writeHead(404).end();
        return;
      }
      infoRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          malformedRuntime
            ? { Runtimes: { runsc: { path: 42, runtimeArgs: 'not-an-array' } } }
            : {
                Runtimes: {
                  runsc: { path: runtimePath, runtimeArgs: [...PINNED_RUNSC_ARGS] },
                },
              },
        ),
      );
    });
    await new Promise<void>((resolve) => docker.listen(0, '127.0.0.1', resolve));
    dockerBaseUrl = `http://127.0.0.1:${String((docker.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      docker.close((error) => (error ? reject(error) : resolve())),
    );
  });

  afterEach(async () => {
    await embedded?.close();
    embedded = undefined;
    runtimePath = PINNED_RUNSC_PATH;
    malformedRuntime = false;
    infoRequests = 0;
  });

  it('attests the pinned Docker runtime and bounds repeated health-probe traffic', async () => {
    embedded = await buildTestEmbeddedServer({
      dockerBaseUrl,
      secretJobRuntimeRequired: true,
      codexEnabled: false,
    });

    for (let count = 1; count <= 2; count += 1) {
      const response = await embedded.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json().secretJobRuntime).toEqual({ required: true, ready: true });
      expect(infoRequests).toBe(1);
    }
  });

  it('degrades without leaking Docker details when runtime registration drifts', async () => {
    embedded = await buildTestEmbeddedServer({
      dockerBaseUrl,
      secretJobRuntimeRequired: true,
      secretJobRuntimeReadinessTtlMs: 0,
      codexEnabled: false,
    });
    const healthy = await embedded.app.inject({ method: 'GET', url: '/healthz' });
    expect(healthy.statusCode).toBe(200);
    runtimePath = '/usr/bin/runc';

    const response = await embedded.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      secretJobRuntime: { required: true, ready: false },
    });
    expect(response.body).not.toContain('runc');
    expect(response.body).not.toContain('/opt/verity');

    runtimePath = PINNED_RUNSC_PATH;
    const recovered = await embedded.app.inject({ method: 'GET', url: '/healthz' });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().secretJobRuntime.ready).toBe(true);
  });

  it('fails closed on malformed Docker runtime metadata', async () => {
    embedded = await buildTestEmbeddedServer({
      dockerBaseUrl,
      secretJobRuntimeRequired: true,
      codexEnabled: false,
    });
    malformedRuntime = true;

    const response = await embedded.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json().secretJobRuntime).toEqual({ required: true, ready: false });
    expect(response.body).not.toContain('not-an-array');
  });

  it('leaves health and Docker untouched when the feature is disabled', async () => {
    embedded = await buildTestEmbeddedServer({ dockerBaseUrl, codexEnabled: false });
    const response = await embedded.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json().secretJobRuntime).toBeUndefined();
    expect(infoRequests).toBe(0);
  });

  it('rejects enabled composition without Docker access', async () => {
    await expect(
      buildTestEmbeddedServer({ secretJobRuntimeRequired: true, codexEnabled: false }),
    ).rejects.toThrow(/dockerBaseUrl is required/);
  });

  it('rejects invalid readiness cache configuration before opening resources', async () => {
    await expect(
      buildTestEmbeddedServer({ secretJobRuntimeReadinessTtlMs: -1, codexEnabled: false }),
    ).rejects.toThrow(/ttl/);
  });
});
