import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPostgresAuditLog, type AuditLog } from './audit-log.js';
import { createAuditRecorder, type AuditRecorder, type BuildIntent } from './audit-recorder.js';
import { registerAuditRoutes } from './audit-routes.js';
import { authorizePairedRoute, type PairedRoutePolicyStore } from './paired-route-policy.js';

let ctx: TestDb;
let log: AuditLog;

beforeAll(async () => {
  ctx = await createTestDb();
  log = createPostgresAuditLog(ctx.db);
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

const server = () => Promise.resolve({ release: '4.57.3', generation: 14 });

function intent(overrides: Partial<BuildIntent> = {}): BuildIntent {
  return {
    projectId: 'p1',
    projectLabel: 'org/repo',
    initiator: { kind: 'user', userId: 'admin-1' },
    imageTag: 'verity-devc-org-repo:abc123def456',
    forceRebuild: false,
    commit: '9c1e4a7',
    baseImageRef: 'ghcr.io/heey-global/verity-sandbox:4.57.0',
    configFingerprint: 'abcdef0123456789',
    features: ['ghcr.io/devcontainers/features/node:1'],
    ...overrides,
  };
}

async function appFor(recorder: AuditRecorder, routes?: string[]): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = 'admin-1';
  });
  if (routes) app.addHook('onRoute', (route) => void routes.push(route.url));
  registerAuditRoutes(app, {
    log,
    recorder,
    sessionName: async (id) => (id === 's1' ? 'Fix login' : null),
  });
  await app.ready();
  return app;
}

describe('audit routes', () => {
  it('lists operations with their status, initiator and image', async () => {
    const recorder = createAuditRecorder(log, { server });
    const done = await recorder.beginBuild(intent());
    await done.succeeded({ imageId: 'sha256:3f9ac21', sizeBytes: 11, baseImageDigest: null });
    await recorder.beginBuild(
      intent({ initiator: { kind: 'session', sessionId: 's1' }, projectId: 'p2' }),
    );
    // A build begun by a process that is gone: no result, not running here.
    await createAuditRecorder(log, { server }).beginBuild(
      intent({ initiator: { kind: 'system', trigger: 'sandbox_wake' } }),
    );
    await recorder.imageRemoved({ imageRef: 'verity-devc-org-repo:old', imageId: 'sha256:old' });
    const app = await appFor(recorder);

    const response = await app.inject('/audit/operations');
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      operations: { kind: string; status: string; initiator: unknown; imageId: string | null }[];
      oldestRecordedAt: string | null;
    }>();
    expect(body.operations.map((op) => [op.kind, op.status])).toEqual([
      ['image_removed', 'recorded'],
      ['build', 'unknown'],
      ['build', 'running'],
      ['build', 'succeeded'],
    ]);
    expect(body.operations.map((op) => op.initiator)).toEqual([
      { kind: 'system', trigger: 'image_cleanup' },
      { kind: 'system', trigger: 'sandbox_wake' },
      { kind: 'session', sessionId: 's1', name: 'Fix login' },
      { kind: 'user', isRequester: true },
    ]);
    expect(body.oldestRecordedAt).not.toBeNull();

    const found = (await app.inject('/audit/operations?q=3f9ac')).json<{
      operations: { operationId: string }[];
    }>();
    expect(found.operations.map((op) => op.operationId)).toEqual([done.operationId]);
    await app.close();
  });

  it('returns the detail of a build', async () => {
    const recorder = createAuditRecorder(log, { server });
    const build = await recorder.beginBuild(intent({ forceRebuild: true }));
    await build.succeeded({
      imageId: 'sha256:3f9ac21',
      sizeBytes: 11_700_000_000,
      baseImageDigest: 'sha256:a07c',
    });
    const app = await appFor(recorder);
    const response = await app.inject(`/audit/operations/${build.operationId}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      operation: {
        status: 'succeeded',
        project: { id: 'p1', label: 'org/repo' },
        server: { release: '4.57.3', generation: 14 },
        build: {
          commit: '9c1e4a7',
          forceRebuild: true,
          baseImageDigest: 'sha256:a07c',
          sizeBytes: 11_700_000_000,
        },
        events: [{ kind: 'build.requested' }, { kind: 'build.succeeded' }],
      },
    });
    expect((await app.inject('/audit/operations/missing')).statusCode).toBe(404);
    expect((await app.inject('/audit/operations?domain=secrets')).statusCode).toBe(400);
    // Answering an unreadable cursor with page one would duplicate it in the client.
    expect((await app.inject('/audit/operations?before=not-a-cursor')).statusCode).toBe(400);
    expect((await app.inject('/audit/operations?since=invalid')).statusCode).toBe(400);
    expect(
      (await app.inject('/audit/operations?since=2026-10-29T00:00:00Z&until=2026-10-28T00:00:00Z'))
        .statusCode,
    ).toBe(400);
    await app.close();
  });

  // The intent gate exists for storage outages; an unusual ref or commit format must
  // never be the reason a build is refused.
  it('records a build whose inputs exceed the allowlist limits', async () => {
    const recorder = createAuditRecorder(log, { server });
    const build = await recorder.beginBuild(
      intent({
        baseImageRef: `registry.example/${'x'.repeat(600)}`,
        commit: 'HEAD',
        configFingerprint: 'not-a-hex-hash',
        features: Array.from({ length: 30 }, (_, i) => `feature-${i}`),
      }),
    );
    await build.succeeded({ imageId: 'sha256:x', sizeBytes: Number.NaN, baseImageDigest: null });
    const events = await log.operation(build.operationId);
    expect(events.map((e) => e.kind)).toEqual(['build.requested', 'build.succeeded']);
    expect(events[0]!.payload).toMatchObject({ commit: null });
  });

  it('reports audit health', async () => {
    const recorder = createAuditRecorder(log, { server });
    const health = vi.spyOn(recorder, 'health');
    const app = await appFor(recorder);
    const response = await app.inject('/audit/health');
    expect(response.json()).toEqual({ status: 'ok', pendingFailedWrites: 0 });
    expect(health).toHaveBeenCalledOnce();
    await app.close();
  });

  // Admin-only comes from these routes being absent from the paired-route policy.
  // Derived from what is registered, so a new audit route cannot slip past it.
  it('keeps every audit route administrator-only', async () => {
    const routes: string[] = [];
    const app = await appFor(createAuditRecorder(log, { server }), routes);
    await app.close();
    expect(routes.length).toBeGreaterThan(0);
    const store: PairedRoutePolicyStore = {
      isActiveLocalUser: async () => true,
      isActiveAdministrator: async (userId) => userId === 'admin',
      hasProjectPermission: async () => true,
      getSession: async () => ({ projectId: 'p1' }),
    };
    for (const url of routes) {
      expect(await authorizePairedRoute(store, 'member', 'GET', url, {})).toBe('forbidden');
      expect(await authorizePairedRoute(store, 'admin', 'GET', url, {})).toBe('allow');
    }
  });
});

it('returns separate safe event records and validates event cursors', async () => {
  const recorder = createAuditRecorder(log, { server });
  const build = await recorder.beginBuild(intent());
  await build.succeeded({ imageId: 'sha256:one', sizeBytes: 1, baseImageDigest: null });
  const app = await appFor(recorder);
  try {
    const response = await app.inject('/audit/events?domain=builds&limit=1');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const page = response.json<{
      events: { kind: string; operationId: string }[];
      nextBefore: string;
    }>();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.kind).toBe('build.succeeded');
    expect(page.events[0]).not.toHaveProperty('initiator');
    expect(page.events[0]).not.toHaveProperty('server');
    const next = (
      await app.inject(
        `/audit/events?domain=builds&limit=1&before=${encodeURIComponent(page.nextBefore)}`,
      )
    ).json();
    expect(next.events[0].kind).toBe('build.requested');
    expect(next.events[0].operationId).toBe(page.events[0]!.operationId);
    expect((await app.inject('/audit/events?before=garbage')).statusCode).toBe(400);
    expect(
      (await app.inject('/audit/events?since=2026-10-29T12:00:00Z&until=2026-10-29T11:00:00Z'))
        .statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
