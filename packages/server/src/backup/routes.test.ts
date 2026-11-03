import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { registerBackupRoutes, type BackupRouteDependencies } from './routes.js';
import { BackupSetupExpiredError } from './setup.js';

it('checks current administrator authority on every registered backup route', async () => {
  const app = Fastify();
  const routes: { method: 'GET' | 'POST' | 'PATCH'; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    const method = route.method;
    if (method === 'GET' || method === 'POST' || method === 'PATCH')
      routes.push({ method: method as 'GET' | 'POST' | 'PATCH', url: route.url });
  });
  let administrator = true;
  const service = {
    status: vi.fn(async () => ({ configured: false, alerts: [] })),
    beginSetup: vi.fn(async () => ({
      id: randomUUID(),
      recoveryKey: 'test-recovery-key',
      expiresAt: 123,
    })),
    confirmSetup: vi.fn(async () => undefined),
    cancelSetup: vi.fn(async () => undefined),
    beginKeyReplacement: vi.fn(async () => ({
      id: randomUUID(),
      recoveryKey: 'replacement-secret',
      expiresAt: 123,
    })),
    confirmKeyReplacement: vi.fn(async () => undefined),
    cancelKeyReplacement: vi.fn(async () => undefined),
    setPolicy: vi.fn(async () => undefined),
    startProbe: vi.fn(async () => {
      throw new Error('not configured');
    }),
    probeStatus: vi.fn(() => null),
    cancelProbe: vi.fn(async () => {
      throw new Error('not configured');
    }),
  };
  const isAdministrator = vi.fn(async (userId: string) => administrator && userId === 'admin');
  registerBackupRoutes(app, {
    userId: (request) =>
      typeof request.headers['x-user'] === 'string' ? request.headers['x-user'] : null,
    isAdministrator,
    service,
  });
  try {
    await app.ready();
    expect(routes.length).toBeGreaterThan(1);
    for (const route of routes) {
      for (const [user, expected] of [
        [undefined, 404],
        ['member', 403],
        ['agent', 403],
        ['project-container', 403],
      ] as const) {
        const response = await app.inject({
          ...route,
          ...(user ? { headers: { 'x-user': user } } : {}),
        });
        expect(response.statusCode, `${route.method} ${route.url} ${user}`).toBe(expected);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    // An available service must never grant project or agent actors administrator authority.
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
    const headers = { 'x-user': 'admin' };
    expect(
      (await app.inject({ method: 'GET', url: '/api/backups/status', headers })).json(),
    ).toMatchObject({ available: true, configured: false });
    expect(
      (await app.inject({ method: 'POST', url: '/api/backups/setup', headers })).json(),
    ).toHaveProperty('recoveryKey');
    const confirmation = { id: randomUUID(), recoveryKey: 'test-recovery-key' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/backups/setup/confirm',
          headers,
          payload: confirmation,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.confirmSetup).toHaveBeenCalledWith(confirmation.id, confirmation.recoveryKey);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/backups/policy',
          headers,
          payload: { paused: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.setPolicy).toHaveBeenCalledWith({ paused: true });
    for (const intervalMs of [3600000, 86400000]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/backups/policy',
            headers,
            payload: { intervalMs },
          })
        ).statusCode,
      ).toBe(200);
      expect(service.setPolicy).toHaveBeenLastCalledWith({ intervalMs });
    }
    for (const payload of [
      {},
      { intervalMs: 3599999 },
      { intervalMs: 86400001 },
      { intervalMs: 3600000.5 },
      { paused: 'true' },
      { extra: true },
    ])
      expect(
        (await app.inject({ method: 'PATCH', url: '/api/backups/policy', headers, payload }))
          .statusCode,
      ).toBe(400);

    expect(
      (await app.inject({ method: 'POST', url: '/api/backups/setup/cancel', headers })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/backups/key-replacement',
          headers,
          payload: { reason: 'exposed' },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.beginKeyReplacement).toHaveBeenCalledWith('exposed');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/backups/key-replacement',
          headers,
          payload: { reason: 'invalid' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/backups/key-replacement/confirm',
          headers,
          payload: confirmation,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.confirmKeyReplacement).toHaveBeenCalledWith(
      confirmation.id,
      confirmation.recoveryKey,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/backups/key-replacement/cancel', headers }))
        .statusCode,
    ).toBe(200);
    administrator = false;
    for (const route of routes)
      expect((await app.inject({ ...route, headers })).statusCode).toBe(403);
    expect(isAdministrator).toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('requires installer resources, validates input and never echoes recovery material from errors', async () => {
  const app = Fastify();
  const service: NonNullable<BackupRouteDependencies['service']> = {
    status: vi.fn(async () => ({ configured: false, alerts: [] })),
    beginSetup: vi.fn(async () => {
      throw new Error('private-key-in-failure');
    }),
    confirmSetup: vi.fn(async () => undefined),
    cancelSetup: vi.fn(async () => undefined),
    beginKeyReplacement: vi.fn(async () => ({
      id: randomUUID(),
      recoveryKey: 'replacement-secret',
      expiresAt: 123,
    })),
    confirmKeyReplacement: vi.fn(async () => undefined),
    cancelKeyReplacement: vi.fn(async () => undefined),
    setPolicy: vi.fn(async () => undefined),
    startProbe: vi.fn(async () => {
      throw new Error('not configured');
    }),
    probeStatus: vi.fn(() => null),
    cancelProbe: vi.fn(async () => {
      throw new Error('not configured');
    }),
  };
  registerBackupRoutes(app, {
    userId: () => 'admin',
    isAdministrator: async () => true,
    service,
  });
  try {
    const failure = await app.inject({ method: 'POST', url: '/api/backups/setup' });
    expect(failure.statusCode).toBe(409);
    expect(failure.body).not.toContain('private-key-in-failure');
    for (const payload of [
      { id: randomUUID(), recoveryKey: 'private', extra: 'unexpected' },
      { id: randomUUID(), recoveryKey: 'x'.repeat(4097) },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/backups/setup/confirm', payload }))
          .statusCode,
      ).toBe(400);
    expect(service.confirmSetup).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
  let unavailableReason: 'installer-required' | 'runtime-unavailable' = 'installer-required';
  const missing = Fastify();
  registerBackupRoutes(missing, {
    unavailableReason: () => unavailableReason,
    userId: () => 'admin',
    isAdministrator: async () => true,
  });
  try {
    expect((await missing.inject({ method: 'GET', url: '/api/backups/status' })).json()).toEqual({
      available: false,
      reason: 'installer-required',
    });
    expect((await missing.inject({ method: 'POST', url: '/api/backups/setup' })).statusCode).toBe(
      503,
    );
    unavailableReason = 'runtime-unavailable';
    expect((await missing.inject({ method: 'GET', url: '/api/backups/status' })).json()).toEqual({
      available: false,
      reason: 'runtime-unavailable',
    });
  } finally {
    await missing.close();
  }
});

it('starts, polls and cancels probe jobs with current admin checks and safe failures', async () => {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      stream: {
        write: (line: string) => {
          logs.push(line);
        },
      },
    },
  });
  const id = randomUUID();
  let administrator = true;
  const job = {
    format: 1 as const,
    installationId: randomUUID(),
    id,
    status: 'running' as const,
    phase: 'selecting' as const,
    startedAt: 1,
    finishedAt: null,
    snapshot: null,
    error: null,
  };
  const service: NonNullable<BackupRouteDependencies['service']> = {
    status: vi.fn(async () => ({ configured: true, alerts: [] })),
    beginSetup: vi.fn(async () => {
      throw new Error();
    }),
    confirmSetup: vi.fn(async () => undefined),
    cancelSetup: vi.fn(async () => undefined),
    beginKeyReplacement: vi.fn(async () => ({
      id: randomUUID(),
      recoveryKey: 'replacement-secret',
      expiresAt: 123,
    })),
    confirmKeyReplacement: vi.fn(async () => undefined),
    cancelKeyReplacement: vi.fn(async () => undefined),
    setPolicy: vi.fn(async () => undefined),
    startProbe: vi.fn(async () => job),
    probeStatus: vi.fn((requested) => (requested === id ? job : null)),
    cancelProbe: vi.fn(async () => ({ ...job, status: 'cancelling' as const })),
  };
  registerBackupRoutes(app, {
    userId: () => 'admin',
    isAdministrator: async () => administrator,
    service,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/backups/probes',
      payload: { recoveryKey: 'private-recovery-key' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id, status: 'running' });
    expect(response.body).not.toContain('private');
    expect(service.startProbe).toHaveBeenCalledWith('private-recovery-key');
    for (const payload of [
      {},
      { recoveryKey: 'x', extra: true },
      { recoveryKey: 'x'.repeat(4097) },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/backups/probes', payload })).statusCode,
      ).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/backups/probes/${id}` })).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject({ method: 'GET', url: `/api/backups/probes/${randomUUID()}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/backups/probes/not-a-uuid' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `/api/backups/probes/${id}/cancel` })).json(),
    ).toMatchObject({ status: 'cancelling' });
    administrator = false;
    for (const route of [
      { method: 'POST' as const, url: '/api/backups/probes' },
      { method: 'GET' as const, url: `/api/backups/probes/${id}` },
      { method: 'POST' as const, url: `/api/backups/probes/${id}/cancel` },
    ])
      expect((await app.inject(route)).statusCode).toBe(403);
    administrator = true;
    vi.mocked(service.startProbe).mockRejectedValueOnce(new Error('private-recovery-key'));
    const failure = await app.inject({
      method: 'POST',
      url: '/api/backups/probes',
      payload: { recoveryKey: 'private-recovery-key' },
    });
    expect(failure.statusCode).toBe(409);
    expect(failure.body).not.toContain('private');
    expect(logs.join('')).not.toContain('private-recovery-key');
  } finally {
    await app.close();
  }
});

it('reports an expired key offer distinctly so clients start over instead of retrying', async () => {
  const app = Fastify();
  const expired = vi.fn(async () => {
    throw new BackupSetupExpiredError();
  });
  const service = {
    confirmSetup: expired,
    confirmKeyReplacement: expired,
  } as unknown as NonNullable<BackupRouteDependencies['service']>;
  registerBackupRoutes(app, {
    userId: () => 'admin',
    isAdministrator: async () => true,
    service,
  });
  try {
    const payload = { id: randomUUID(), recoveryKey: 'verity-recovery-v1.sample' };
    for (const url of ['/api/backups/setup/confirm', '/api/backups/key-replacement/confirm']) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode, url).toBe(410);
      expect(response.json()).toEqual({ error: 'backup key offer expired' });
      expect(response.body).not.toContain(payload.recoveryKey);
    }
  } finally {
    await app.close();
  }
});
