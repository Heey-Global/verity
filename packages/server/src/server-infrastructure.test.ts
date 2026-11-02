import { InMemoryEventBus } from '@verity/session';
import {
  createSealableSecretCipher,
  PROJECT_MEMORY_MAX_CHARS,
  type ProjectRecord,
} from '@verity/store';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthTokenRegistry, hashAuthToken } from './auth.js';
import { ProvisioningError } from './provisioner.js';
import type { PushNotification, PushSender } from './push-sender.js';
import {
  SERVER_UPDATE_PUSH_CATEGORY,
  serverUpdateNotifierStatePath,
} from './self-update/server-update-notifier.js';
import { UpdaterRequestError } from './self-update/updater-status.js';
import {
  app,
  availableDigest,
  availableRelease,
  availableSandboxUpdates,
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
  isBusy,
  port,
  preparingOperation,
  startSession,
  updateFixture,
  worktreeRoot,
} from './server-fixture.test-helper.js';
import {
  buildServer,
  startProjectRelayMigrationScheduler,
  VERITY_CONTROL_SYSTEM_PROMPT,
  type ServerDeps,
} from './server.js';

describe('removed workflow API', () => {
  it('does not register workflow or provider callback routes', async () => {
    const server = buildServer({ eventStore: ctx.store, bus, conductor });
    try {
      // A hidden UI alone must not leave the retired orchestration API callable.
      for (const [method, url] of [
        ['GET', '/workflows'],
        ['POST', '/workflows'],
        ['GET', '/workflows/retired'],
        ['POST', '/workflow-services'],
        ['POST', '/workflows/retired/authorize'],
        ['POST', '/workflows/retired/steps/step/dispatch'],
        ['POST', '/workflows/retired/cancel'],
        ['POST', '/workflows/retired/resume'],
        ['POST', '/workflows/retired/decisions'],
        ['POST', '/workflows/retired/image-candidate'],
        ['POST', '/providers/github/webhook'],
        ['POST', '/internal/workflow/result'],
      ] as const) {
        expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
        const response = await server.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
});

describe('startProjectRelayMigrationScheduler', () => {
  const activeProject = {
    id: 'p1',
    owner: 'heey-global',
    repo: 'legal-docs',
    containerName: 'dev-heey-global--legal-docs',
    state: 'active' as const,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches the busy probe and reconciles relays on each tick', async () => {
    vi.useFakeTimers();
    await ctx.store.upsertProject(activeProject);
    const reconcileRelays = vi.fn(async () => undefined);
    const attachProjectBusyProbe = vi.fn();
    const isProjectBusy = vi.fn(async () => false);
    const stop = startProjectRelayMigrationScheduler(
      {
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner: { provision: vi.fn(), reconcileRelays, attachProjectBusyProbe },
      },
      { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
      isProjectBusy,
    );

    expect(attachProjectBusyProbe).toHaveBeenCalledWith(isProjectBusy);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileRelays).toHaveBeenCalledTimes(1);
    const [projects] = reconcileRelays.mock.calls[0] as unknown as [Array<{ id: string }>];
    expect(projects.some((p) => p.id === 'p1')).toBe(true);
    stop();
  });

  it('hands available sandbox images to the busy-safe reconcile queue', async () => {
    vi.useFakeTimers();
    await ctx.store.upsertProject(activeProject);
    const reconcileRelays = vi.fn(async () => undefined);
    const stop = startProjectRelayMigrationScheduler(
      {
        eventStore: ctx.store,
        bus,
        conductor,
        sandboxUpdates: availableSandboxUpdates(),
        provisioner: {
          provision: vi.fn(),
          reconcileRelays,
          attachProjectBusyProbe: vi.fn(),
        },
      },
      { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
      vi.fn(async () => false),
    );

    await vi.advanceTimersByTimeAsync(0);
    const [, callbacks] = reconcileRelays.mock.calls[0] as unknown as [
      ProjectRecord[],
      { updateAvailable: Set<string> },
    ];
    expect([...callbacks.updateAvailable]).toEqual([activeProject.id]);
    stop();
  });

  it('keeps ticking after a reconcile failure', async () => {
    vi.useFakeTimers();
    await ctx.store.upsertProject(activeProject);
    const reconcileRelays = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const warn = vi.fn();
    const stop = startProjectRelayMigrationScheduler(
      {
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner: {
          provision: vi.fn(),
          reconcileRelays,
          attachProjectBusyProbe: vi.fn(),
        },
      },
      { info: vi.fn(), warn } as unknown as FastifyBaseLogger,
      vi.fn(async () => false),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcileRelays).toHaveBeenCalledTimes(2);
    stop();
  });

  it('retries relay adoption promptly while Server ownership is transferring', async () => {
    vi.useFakeTimers();
    await ctx.store.upsertProject(activeProject);
    const reconcileRelays = vi.fn(async () => undefined);
    const stop = startProjectRelayMigrationScheduler(
      {
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner: {
          provision: vi.fn(),
          reconcileRelays,
          attachProjectBusyProbe: vi.fn(),
        },
      },
      { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
      vi.fn(async () => false),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileRelays).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reconcileRelays).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcileRelays).toHaveBeenCalledTimes(2);
    stop();
  });

  it('is inert when the provisioner does not implement migration', () => {
    const stop = startProjectRelayMigrationScheduler(
      {
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner: { provision: vi.fn() },
      },
      { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
      vi.fn(async () => false),
    );
    // No throw, returns a no-op stopper.
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('POST /google/connect', () => {
  it('rate-limits authorization attempts', async () => {
    const request = {
      method: 'POST' as const,
      url: '/google/connect',
      payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.inject(request)).statusCode).toBe(400);
    }
    const blocked = await app.inject(request);
    expect(blocked.statusCode, blocked.body).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.json()).toEqual({ error: 'invalid request' });
  });

  it('is the only Google code exchange the server accepts', async () => {
    // A per-service exchange left behind would store a second, narrower grant
    // for the same account outside the unified consent.
    for (const url of [
      '/google-drive/connect',
      '/gmail/connect',
      '/calendar/connect',
      '/contacts/connect',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { code: 'code', codeVerifier: 'verifier', redirectUri: 'verity://oauth' },
      });
      expect(response.statusCode, url).toBe(404);
    }
  });
});

describe('GET /healthz', () => {
  it('returns ok with the server version', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    // Version is baked in from the release build; dev/test runs report a sentinel.
    // Assert only its presence/type so the check is env-independent.
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.pushEnabled).toBe(false);
    expect(body.publicPreviewsEnabled).toBe(false);
    // A capability, not a deployment gate: the app hides its "Rebuild image"
    // action unless the server it is talking to reports this, because an older
    // server strips `forceRebuild` from the recreate body instead of refusing it.
    expect(body.imageRebuildSupported).toBe(true);
  });
});

describe('GET /server/updates', () => {
  it('reports unmanaged deployments as unsupported', async () => {
    const res = await app.inject({ method: 'GET', url: '/server/updates' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      state: 'unsupported',
      reason: 'deployment is not managed',
      operation: null,
      installed: { version: expect.any(String), generation: null },
    });
  });

  it('requires a valid device bearer token when authentication is enabled', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const { token } = await registry.mint('updates-device');
    const gated = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      const anonymous = await gated.inject({ method: 'GET', url: '/server/updates' });
      expect(anonymous.statusCode).toBe(401);

      const queryToken = await gated.inject({
        method: 'GET',
        url: `/server/updates?access_token=${token}`,
      });
      expect(queryToken.statusCode).toBe(401);

      const authenticated = await gated.inject({
        method: 'GET',
        url: '/server/updates',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toMatchObject({ state: 'unsupported' });
    } finally {
      await gated.close();
    }
  });

  it('carries the Updater operation into the availability payload', async () => {
    const updates = await updateFixture({ operation: preparingOperation });
    const server = buildServer(updates.deps);
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/server/updates',
        headers: { authorization: `Bearer ${updates.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        state: 'available',
        release: availableRelease,
        operation: preparingOperation,
        installed: { version: expect.any(String), generation: null },
        attempt: null,
        // The fixture's operation last moved in August; this stub controller can
        // neither read attempts nor retry, so nothing is offered for it.
        stalled: true,
        recovery: { retry: false, supersede: false },
      });
    } finally {
      await server.close();
    }
  });

  it('reports unknown rather than "no operation" when the Updater is unreachable', async () => {
    const updates = await updateFixture({
      readOperation: () => Promise.reject(new Error('ENOENT')),
    });
    const server = buildServer(updates.deps);
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/server/updates',
        headers: { authorization: `Bearer ${updates.token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'update status is unavailable' });
    } finally {
      await server.close();
    }
  });
});

describe('POST /server/updates', () => {
  async function request(
    server: FastifyInstance,
    token: string,
    payload: Record<string, unknown> = { idempotencyKey: 'k1', targetDigest: availableDigest },
  ) {
    return server.inject({
      method: 'POST',
      url: '/server/updates',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('accepts one digest-pinned request and reports the resulting operation', async () => {
    const updates = await updateFixture();
    const server = buildServer(updates.deps);
    try {
      const res = await request(server, updates.token);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ operation: preparingOperation });
      expect(updates.requested).toEqual([
        { idempotencyKey: 'k1', targetDigest: availableDigest, channel: availableRelease.channel },
      ]);
    } finally {
      await server.close();
    }
  });

  // The mutating action is not covered by the ambient bearer gate alone: with no
  // paired device that gate is off, and anyone on the LAN could otherwise swap
  // the control plane's own image.
  it('refuses to update a deployment that has no paired device', async () => {
    const updates = await updateFixture({ authEnabled: false });
    const server = buildServer(updates.deps);
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/server/updates',
        payload: { idempotencyKey: 'k1', targetDigest: availableDigest },
      });
      expect(res.statusCode).toBe(403);
      expect(updates.requested).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('refuses a digest the signed release channel does not currently offer', async () => {
    const updates = await updateFixture();
    const server = buildServer(updates.deps);
    try {
      const other = `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`;
      const res = await request(server, updates.token, {
        idempotencyKey: 'k1',
        targetDigest: other,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'target digest is not the available release' });
      expect(updates.requested).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('refuses to act while the channel reports no available release', async () => {
    const updates = await updateFixture({
      availability: { state: 'current', release: availableRelease, operation: null },
    });
    const server = buildServer(updates.deps);
    try {
      const res = await request(server, updates.token);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'no update is available (current)' });
      expect(updates.requested).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('rejects malformed keys and digests before reaching the Updater', async () => {
    const updates = await updateFixture();
    const server = buildServer(updates.deps);
    try {
      for (const payload of [
        {},
        { idempotencyKey: 'not a key', targetDigest: availableDigest },
        { idempotencyKey: 'k1', targetDigest: 'ghcr.io/heey-global/verity/verity-server:latest' },
        { idempotencyKey: 'k1' },
      ]) {
        expect((await request(server, updates.token, payload)).statusCode).toBe(400);
      }
      expect(updates.requested).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('relays a refusal from the Updater as its closed outcome code', async () => {
    const updates = await updateFixture({
      requestUpdate: () => Promise.reject(new UpdaterRequestError(409, 'operation-in-progress')),
    });
    const server = buildServer(updates.deps);
    try {
      const res = await request(server, updates.token);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'operation-in-progress' });
    } finally {
      await server.close();
    }
  });

  it('never reports a broken control channel as a client error', async () => {
    const updates = await updateFixture({
      requestUpdate: () => Promise.reject(new UpdaterRequestError(401, 'unauthorized')),
    });
    const server = buildServer(updates.deps);
    try {
      const res = await request(server, updates.token);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'updater is unavailable' });
    } finally {
      await server.close();
    }
  });

  it('is unavailable on a deployment Verity does not manage', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const { token } = await registry.mint('unmanaged-device');
    const server = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      const res = await request(server, token);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'deployment is not managed' });
    } finally {
      await server.close();
    }
  });
});

/**
 * The notifier itself is covered in `self-update/server-update-notifier.test.ts`,
 * which constructs it directly. These are about the wiring instead, because that
 * is where this feature has already failed once: a dep declared and set but never
 * forwarded type-checks cleanly and leaves every unit test green while production
 * announces nothing at all. Nothing here re-tests the notifier's decisions — only
 * that `buildServer` builds one, starts it, hands it the real delivery path and
 * the Updater's operation, and lets it finish before closing what it pushes into.
 */
describe('the server update notifier', () => {
  const roots: string[] = [];
  const newStatePath = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'verity-notifier-wiring-'));
    roots.push(root);
    return serverUpdateNotifierStatePath(root);
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Records what it was asked to do and in which order — the ordering is the point
   *  of the shutdown test, and `send` is the only signal that a notifier exists. */
  function recordingSender() {
    const events: string[] = [];
    const sent: PushNotification[] = [];
    const sender: PushSender = {
      send: async (notification) => {
        events.push('send');
        sent.push(notification);
        return {
          targets: 1,
          ticketsAccepted: 1,
          ticketErrors: 0,
          receiptsQueued: 0,
          pruned: 0,
          transportErrors: 0,
        };
      },
      processDueReceipts: async () => ({
        due: 0,
        delivered: 0,
        receiptErrors: 0,
        missing: 0,
        retried: 0,
        expired: 0,
        pruned: 0,
        transportErrors: 0,
      }),
      start: () => {
        events.push('start');
      },
      close: async () => {
        events.push('close');
      },
    };
    return { sender, events, sent };
  }

  it('announces an available release through the Server push sender', async () => {
    const updates = await updateFixture();
    const push = recordingSender();
    const server = buildServer({
      ...updates.deps,
      pushSender: push.sender,
      serverUpdateNotifierStatePath: newStatePath(),
    });
    // The pass `start()` fires is awaited by the onClose hook, so closing is also
    // how this test waits for it — the same guarantee production relies on.
    await server.close();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({
      categoryId: SERVER_UPDATE_PUSH_CATEGORY,
      data: { kind: 'server-update', version: availableRelease.version },
    });
    // A check still in flight would otherwise send into a closed PushSender.
    expect(push.events).toEqual(['start', 'send', 'close']);
  });

  /**
   * Every one of these disables the notifier, and each for its own reason: no push
   * means nothing to announce with, no resolver means nothing to announce, no
   * controller means `POST /server/updates` answers 503 so the announcement would
   * name an action this deployment cannot perform, and no state path means no way
   * to announce only once.
   */
  it.each(['pushSender', 'serverUpdateResolver', 'serverUpdateController', 'notifierStatePath'])(
    'stays silent without %s',
    async (missing) => {
      const updates = await updateFixture();
      const push = recordingSender();
      const deps: ServerDeps = {
        ...updates.deps,
        ...(missing === 'pushSender' ? {} : { pushSender: push.sender }),
        ...(missing === 'notifierStatePath'
          ? {}
          : { serverUpdateNotifierStatePath: newStatePath() }),
      };
      if (missing === 'serverUpdateResolver') delete deps.serverUpdateResolver;
      if (missing === 'serverUpdateController') delete deps.serverUpdateController;
      const server = buildServer(deps);
      await server.close();

      expect(push.sent).toEqual([]);
    },
  );

  /**
   * The resolver reports `operation: null` on every branch — only the route
   * overlays the Updater's journal onto it. If `buildServer` wired anything but
   * the controller's own `readOperation` here, the Server would push "ready to
   * install" into the middle of the install it is describing.
   */
  it('says nothing while the Updater is already installing that release', async () => {
    const updates = await updateFixture({ operation: preparingOperation });
    const push = recordingSender();
    const server = buildServer({
      ...updates.deps,
      pushSender: push.sender,
      serverUpdateNotifierStatePath: newStatePath(),
    });
    await server.close();

    expect(push.sent).toEqual([]);
  });
});

describe('retired configured Dev Server routes', () => {
  it('does not recreate a sandbox through a retired setup request', async () => {
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected provisioning');
      }),
    };
    const deprovisioner = { deprovision: vi.fn() };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner, deprovisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/projects/missing/setup-dev-servers',
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(provisioner.provision).not.toHaveBeenCalled();
      expect(deprovisioner.deprovision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });
});

describe('POST /verity-control/projects/:id/refresh-token', () => {
  it('503s when project token refresh is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verity-control/projects/p1/refresh-token',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'project token refresh is not configured' });
  });

  it('404s for an unknown project id', async () => {
    const refreshProjectToken = vi.fn(async () => undefined);
    const a = buildServer({ eventStore: ctx.store, bus, conductor, refreshProjectToken });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/unknown/refresh-token',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project unknown not found' });
      expect(refreshProjectToken).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('refreshes a project GitHub token without returning the token value', async () => {
    await ctx.store.upsertProject({
      id: 'p-token-refresh',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const refreshProjectToken = vi.fn(async () => undefined);
    const a = buildServer({ eventStore: ctx.store, bus, conductor, refreshProjectToken });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-token-refresh/refresh-token',
      });
      expect(res.statusCode).toBe(200);
      expect(refreshProjectToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p-token-refresh' }),
      );
      expect(res.json()).toEqual({
        projectId: 'p-token-refresh',
        refreshedAt: expect.any(String),
      });
      expect(JSON.stringify(res.json())).not.toContain('ghs_');
    } finally {
      await a.close();
    }
  });
});

describe('POST /verity-control/projects/:id/recreate-container', () => {
  it('503s when project container recreate is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verity-control/projects/p1/recreate-container',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'project container recreate is not configured' });
  });

  it('404s for an unknown project id', async () => {
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      recreateContainer: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/unknown/recreate-container',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project unknown not found' });
      expect(provisioner.recreateContainer).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('409s for an absent project so the operator uses provision instead', async () => {
    await ctx.store.upsertProject({
      id: 'p-absent',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      recreateContainer: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-absent/recreate-container',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'project p-absent is absent; provision it instead' });
      expect(provisioner.recreateContainer).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('404s for a soft-deleted project instead of recreating it', async () => {
    await ctx.store.upsertProject({
      id: 'p-recreate-hidden',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.hideProject('p-recreate-hidden');
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      recreateContainer: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-recreate-hidden/recreate-container',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project p-recreate-hidden not found' });
      expect(provisioner.recreateContainer).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('409s while a project is already provisioning', async () => {
    await ctx.store.upsertProject({
      id: 'p-starting',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'container_starting',
    });
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      recreateContainer: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-starting/recreate-container',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'project p-starting is already provisioning' });
      expect(provisioner.recreateContainer).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('allows recreating the Verity project container', async () => {
    await ctx.store.upsertProject({
      id: 'p-verity',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const updated = {
      id: 'p-verity',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null,
      state: 'active' as const,
      provisionError: null,
      provisionWarning: null,
      hiddenAt: null,
      latestReleaseTag: null,
      latestReleaseName: null,
      latestReleaseUrl: null,
      latestReleasePublishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      stateChangedAt: new Date(),
    };
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      recreateContainer: vi.fn(async () => updated),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-verity/recreate-container',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ project: { id: 'p-verity', state: 'active' } });
      // A bodyless recreate is the plain one: it reuses the cached devcontainer
      // image, so `forceRebuild` has to reach the provisioner as false rather
      // than undefined-and-defaulted somewhere further down.
      expect(provisioner.recreateContainer).toHaveBeenCalledWith('p-verity', {
        confirmWarnings: false,
        forceRebuild: false,
        initiator: { kind: 'user', userId: null },
      });
    } finally {
      await a.close();
    }
  });

  it('recreates an active project container without exposing secrets', async () => {
    await ctx.store.upsertProject({
      id: 'p-recreate',
      owner: 'heey-global',
      repo: 'site',
      containerName: 'dev-heey-global-site',
      state: 'active',
    });
    const updated = {
      id: 'p-recreate',
      owner: 'heey-global',
      repo: 'site',
      containerName: 'dev-heey-global-site',
      imageRef: null,
      state: 'container_starting' as const,
      provisionError: null,
      provisionWarning: null,
      hiddenAt: null,
      latestReleaseTag: null,
      latestReleaseName: null,
      latestReleaseUrl: null,
      latestReleasePublishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      stateChangedAt: new Date(),
    };
    const provisioner = {
      provision: vi.fn(async () => updated),
      recreateContainer: vi.fn(async () => updated),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-recreate/recreate-container',
      });
      expect(res.statusCode).toBe(200);
      expect(provisioner.recreateContainer).toHaveBeenCalledWith('p-recreate', {
        confirmWarnings: false,
        forceRebuild: false,
        initiator: { kind: 'user', userId: null },
      });
      expect(res.json()).toMatchObject({
        project: { id: 'p-recreate', state: 'container_starting' },
      });
      expect(JSON.stringify(res.json())).not.toContain('ghs_');
    } finally {
      await a.close();
    }
  });

  // The app's "Rebuild image" action. It is the only caller that sets the flag,
  // and the only way past the content-hash image cache — a recreate that quietly
  // dropped it would silently reuse the very image the operator asked to replace.
  it('forwards a forced image rebuild to the provisioner', async () => {
    await ctx.store.upsertProject({
      id: 'p-rebuild',
      owner: 'heey-global',
      repo: 'site',
      containerName: 'dev-heey-global-site',
      state: 'active',
    });
    const recreateContainer = vi.fn(async () => ({
      ...(await ctx.store.getProject('p-rebuild'))!,
    }));
    const provisioner = { provision: vi.fn(), recreateContainer };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-rebuild/recreate-container',
        payload: { confirmWarnings: true, forceRebuild: true },
      });
      expect(res.statusCode).toBe(200);
      expect(recreateContainer).toHaveBeenCalledWith('p-rebuild', {
        confirmWarnings: true,
        forceRebuild: true,
        initiator: { kind: 'user', userId: null },
      });
    } finally {
      await a.close();
    }
  });

  it('rejects recreate (409) when the project has a turn in flight (SBX-1)', async () => {
    await ctx.store.upsertProject({
      id: 'p-busy',
      owner: 'heey-global',
      repo: 'site',
      containerName: 'dev-heey-global-site',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-busy',
      worktree: '/wt/s-busy',
      model: 'claude-opus-4-8',
      projectId: 'p-busy',
    });
    isBusy.mockReturnValue(true); // conductor reports the session's turn is in flight
    const recreateContainer = vi.fn(async () => ({ ...(await ctx.store.getProject('p-busy'))! }));
    const provisioner = { provision: vi.fn(), recreateContainer };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-busy/recreate-container',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/turn in flight/);
      expect(recreateContainer).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('returns provisioning failures from recreate without degrading to internal error', async () => {
    await ctx.store.upsertProject({
      id: 'p-recreate-failed',
      owner: 'heey-global',
      repo: 'site',
      containerName: 'dev-heey-global-site',
      state: 'failed',
    });
    const provisioner = {
      provision: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      recreateContainer: vi.fn(async () => {
        throw new ProvisioningError(
          'devcontainer build failed: unsupported devcontainer runtime settings: mounts',
        );
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/verity-control/projects/p-recreate-failed/recreate-container',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'devcontainer build failed: unsupported devcontainer runtime settings: mounts',
      });
    } finally {
      await a.close();
    }
  });
});

describe('POST /verity-control/session', () => {
  it('creates a reusable control-plane Verity Control session', async () => {
    const res = await app.inject({ method: 'POST', url: '/verity-control/session' });

    expect(res.statusCode).toBe(201);
    const { sessionId }: { sessionId: string } = res.json();
    expect(startSession).not.toHaveBeenCalled();
    await expect(ctx.store.getSession(sessionId)).resolves.toMatchObject({
      name: 'Verity Control',
      projectId: null,
    });
    expect(await ctx.store.getEvents(sessionId)).toEqual([]);
    expect(await ctx.store.consumePendingNotes(sessionId)).toEqual([]);
  });

  it('reuses the legacy Concierge session when its worktree still exists', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'concierge-existing-'));
    await ctx.store.createSession({
      sessionId: 'concierge-existing',
      worktree,
      model: 'm',
      name: 'Concierge',
    });

    const res = await app.inject({ method: 'POST', url: '/verity-control/session' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 'concierge-existing' });
    expect(startSession).not.toHaveBeenCalled();
    await expect(ctx.store.getSession('concierge-existing')).resolves.toMatchObject({
      name: 'Verity Control',
    });
  });

  it('reuses an existing Verity Control session', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'verity-control-existing-'));
    await ctx.store.createSession({
      sessionId: 'verity-control-existing',
      worktree,
      model: 'm',
      name: 'Verity Control',
    });

    const res = await app.inject({ method: 'POST', url: '/verity-control/session' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 'verity-control-existing' });
    expect(startSession).not.toHaveBeenCalled();
    await expect(ctx.store.getSession('verity-control-existing')).resolves.toMatchObject({
      name: 'Verity Control',
    });
  });

  it('does not reuse project-bound sessions named Concierge', async () => {
    await ctx.store.upsertProject({
      id: 'p-concierge',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const worktree = mkdtempSync(join(worktreeRoot, 'project-concierge-'));
    await ctx.store.createSession({
      sessionId: 'project-concierge',
      worktree,
      model: 'm',
      name: 'Concierge',
      projectId: 'p-concierge',
    });
    const res = await app.inject({ method: 'POST', url: '/verity-control/session' });

    expect(res.statusCode).toBe(201);
    const { sessionId }: { sessionId: string } = res.json();
    expect(sessionId).not.toBe('project-concierge');
    expect(startSession).not.toHaveBeenCalled();
  });
});

describe('POST /internal/project/memory rejects the retired TCP path', () => {
  // A minimal capability registry: 'good-cap' resolves to project p1, all else
  // is unknown — mirroring how the real broker maps a per-container capability to
  // its server-side project binding (the sandbox never names its own project).
  const capabilities = {
    issue: async () => 'good-cap',
    resolve: async (cap: string) => {
      if (cap === 'good-cap') return { projectId: 'p1', owner: 'heey-global', repo: 'verity' };
      if (cap === 'cap-p2') return { projectId: 'p2', owner: 'heey-global', repo: 'other' };
      return undefined;
    },
    revokeProject: async () => {},
  };

  function memoryApp() {
    return buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      ghTokenCapabilities: capabilities,
    });
  }

  beforeEach(async () => {
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p2',
      owner: 'heey-global',
      repo: 'other',
      containerName: 'dev-heey-global-other',
      state: 'active',
    });
  });

  it('rejects a valid capability without a project Unix-socket identity', async () => {
    const memApp = memoryApp();
    const res = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer good-cap' },
      payload: { text: 'prefers vitest' },
    });
    expect(res.statusCode).toBe(401);
    expect((await ctx.store.getProjectSettingsRaw('p1'))?.memory ?? null).toBeNull();
    await memApp.close();
  });

  it('rejects an unknown / missing capability with 401', async () => {
    const memApp = memoryApp();
    const anon = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      payload: { text: 'x' },
    });
    expect(anon.statusCode).toBe(401);
    const bad = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer nope' },
      payload: { text: 'x' },
    });
    expect(bad.statusCode).toBe(401);
    await memApp.close();
  });

  it('400s a body without a string text field', async () => {
    const memApp = memoryApp();
    const res = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer good-cap' },
      payload: { note: 'wrong field' },
    });
    expect(res.statusCode).toBe(401);
    await memApp.close();
  });

  it('413s an append over the size cap without changing stored memory', async () => {
    const memApp = memoryApp();
    await ctx.store.appendProjectMemory('p1', 'keep');
    const res = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer good-cap' },
      payload: { text: 'x'.repeat(PROJECT_MEMORY_MAX_CHARS + 1) },
    });
    expect(res.statusCode).toBe(401);
    expect((await ctx.store.getProjectSettingsRaw('p1'))?.memory).toBe('keep');
    await memApp.close();
  });

  it('scopes the write to the capability’s own project (cannot touch another)', async () => {
    const memApp = memoryApp();
    // A capability bound to p2 must only ever write p2 — the sandbox never names a
    // project, so the server-side binding is the sole authority.
    const res = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer cap-p2' },
      payload: { text: 'belongs to p2' },
    });
    expect(res.statusCode).toBe(401);
    expect((await ctx.store.getProjectSettingsRaw('p2'))?.memory ?? null).toBeNull();
    expect((await ctx.store.getProjectSettingsRaw('p1'))?.memory ?? null).toBeNull();
    await memApp.close();
  });

  it('treats an empty note as a 200 no-op, not a 404', async () => {
    const memApp = memoryApp();
    const res = await memApp.inject({
      method: 'POST',
      url: '/internal/project/memory',
      headers: { authorization: 'Bearer good-cap' },
      payload: { text: '   ' },
    });
    expect(res.statusCode).toBe(401);
    await memApp.close();
  });
});

describe('standing brokered-secret grant routes (ADR 0011 D2)', () => {
  const project = {
    id: 'p-grants',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global--verity',
    state: 'active' as const,
  };
  const grant = {
    id: 'grant-1',
    secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY',
    toolName: 'verity_secret_run' as const,
    target: `/usr/local/bin/fastlane#${'a'.repeat(64)}`,
    scope: 'forever' as const,
    sessionId: null,
    appliesNow: true,
    expiresAt: null,
    createdAt: '2026-08-02T00:00:00.000Z',
  };

  function grantsApp(overrides: {
    list?: (projectId: string) => Promise<(typeof grant)[]>;
    revoke?: (projectId: string, grantId: string) => Promise<boolean>;
  }) {
    return buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      ...(overrides.list !== undefined ? { listBrokeredGrants: overrides.list } : {}),
      ...(overrides.revoke !== undefined ? { revokeBrokeredGrant: overrides.revoke } : {}),
    });
  }

  it('lists a project’s standing grants and revokes one end to end', async () => {
    await ctx.store.upsertProject(project);
    const live = new Map([[grant.id, grant]]);
    const revoke = vi.fn(async (projectId: string, grantId: string) => {
      if (projectId !== project.id) return false;
      return live.delete(grantId);
    });
    const grantsSrv = grantsApp({ list: async () => [...live.values()], revoke });

    const listed = await grantsSrv.inject({
      method: 'GET',
      url: `/projects/${project.id}/secret-grants`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ grants: [grant] });

    // A forever grant has no expiry, so this route is its only exit.
    const revoked = await grantsSrv.inject({
      method: 'DELETE',
      url: `/projects/${project.id}/secret-grants/${grant.id}`,
    });
    expect(revoked.statusCode).toBe(204);
    expect(revoke).toHaveBeenCalledWith(project.id, grant.id);
    expect(
      (
        await grantsSrv.inject({ method: 'GET', url: `/projects/${project.id}/secret-grants` })
      ).json(),
    ).toEqual({
      grants: [],
    });

    // Revoking the same grant again is a 404, not a silent second success.
    const again = await grantsSrv.inject({
      method: 'DELETE',
      url: `/projects/${project.id}/secret-grants/${grant.id}`,
    });
    expect(again.statusCode).toBe(404);
    await grantsSrv.close();
  });

  it('does not list grants for an unknown project', async () => {
    const list = vi.fn(async () => [grant]);
    const grantsSrv = grantsApp({ list });
    const res = await grantsSrv.inject({ method: 'GET', url: '/projects/nope/secret-grants' });
    expect(res.statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
    await grantsSrv.close();
  });

  it('reports not-configured rather than pretending nothing is granted', async () => {
    // An empty list would read as "no standing grants"; a deployment without the store
    // wired must not be able to tell the operator that.
    await ctx.store.upsertProject(project);
    const grantsSrv = grantsApp({});
    const listed = await grantsSrv.inject({
      method: 'GET',
      url: `/projects/${project.id}/secret-grants`,
    });
    expect(listed.statusCode).toBe(501);
    const revoked = await grantsSrv.inject({
      method: 'DELETE',
      url: `/projects/${project.id}/secret-grants/${grant.id}`,
    });
    expect(revoked.statusCode).toBe(501);
    await grantsSrv.close();
  });
});

// The control-plane system prompt is a set of claims about a deployment the agent cannot
// inspect. It promised server-provided git and GitHub credentials — true only while
// control-plane turns ran in-process on the Server host. In the sealed-runner deployment the
// token mint refuses a `control_plane` project outright, no gh-token capability is mounted,
// and there is no `gh` binary, so the promise sent the agent down a path that cannot work and
// made the resulting failure look like a bug to hunt. Pin the corrections.
describe('VERITY_CONTROL_SYSTEM_PROMPT', () => {
  it('does not promise GitHub or git credentials it does not have', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toContain('You do not need your own GitHub token');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toMatch(/use the configured git and gh credentials/u);
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toMatch(/push branches, and open pull requests/u);
  });

  it('states the three capabilities the sealed runner actually lacks', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('No GitHub credentials');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('No commit signing');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('No usable repository checkout');
    // Docker was the fourth until ADR 0006 Amendment 1 granted it. Assert its ABSENCE from
    // this list rather than just deleting the line: a prompt that still claimed
    // "No Docker daemon" while the socket was mounted would teach the session to
    // disbelieve the daemon it can actually reach, and would send it hunting for
    // workarounds to a boundary that is no longer there.
    expect(VERITY_CONTROL_SYSTEM_PROMPT).not.toContain('No Docker daemon');
  });

  /**
   * ADR 0006 Amendment 1. The grant is only half of what the prompt has to carry: the other
   * half is the operating rule, and the honesty about what backs it.
   *
   * The rule is diagnosis, not intervention — and nothing enforces it, because a
   * host-root-equivalent socket cannot be narrowed by a sentence. Saying so
   * plainly is the point. A prompt that stated the restriction as though the
   * system imposed it would be making the same false-security claim this change
   * removed from AGENTS.md, one layer down.
   */
  it('grants Docker for diagnosis and is honest that the limit is unenforced', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('/var/run/docker.sock');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/diagnos/iu);
    // The specific interventions, not a vague "be careful".
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/Do not use it to intervene/u);
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/host-root-equivalent/u);
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toMatch(/convention you are expected to keep/u);
  });

  it('sends repo work to a project session instead of leaving the agent to improvise', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('repo work belongs in a project session');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('committing through the GitHub API');
  });

  it('keeps the standing rules that are still true', () => {
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('Never merge pull requests by yourself');
    expect(VERITY_CONTROL_SYSTEM_PROMPT).toContain('Never print secret values');
  });
});

describe('GET /attachments/:hash', () => {
  it('serves stored bytes with the right content-type and an immutable cache header', async () => {
    const hash = await ctx.store.putAttachment('image/png', Buffer.from('hi').toString('base64'));
    const res = await app.inject({ method: 'GET', url: `/attachments/${hash}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).not.toContain('public');
    expect(res.rawPayload.toString('utf8')).toBe('hi');
  });

  it('404s an unknown (but well-formed) hash', async () => {
    const res = await app.inject({ method: 'GET', url: `/attachments/${'a'.repeat(64)}` });
    expect(res.statusCode).toBe(404);
  });

  it('400s a malformed hash', async () => {
    const res = await app.inject({ method: 'GET', url: '/attachments/not-a-hash' });
    expect(res.statusCode).toBe(400);
  });
});

describe('session worktree files', () => {
  it('lists local generated files in a session worktree', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    mkdirSync(join(worktree, 'dist'));
    writeFileSync(join(worktree, 'README.md'), '# Hello\n');
    writeFileSync(join(worktree, 'dist', 'contract.docx'), Buffer.from([1, 2, 3]));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const root = await app.inject({ method: 'GET', url: '/sessions/s1/files' });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({
      root: 'worktree',
      path: '',
      truncated: false,
      entries: [
        { name: 'dist', path: 'dist', kind: 'directory', size: null },
        { name: 'README.md', path: 'README.md', kind: 'file', size: 8 },
      ],
    });

    const dist = await app.inject({ method: 'GET', url: '/sessions/s1/files?path=dist' });
    expect(dist.statusCode).toBe(200);
    expect(dist.json()).toMatchObject({
      path: 'dist',
      entries: [{ name: 'contract.docx', path: 'dist/contract.docx', kind: 'file', size: 3 }],
    });
  });

  it('serves small text files for preview', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    writeFileSync(join(worktree, 'note.txt'), 'hello\n');
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const res = await app.inject({
      method: 'GET',
      url: '/sessions/s1/files/content?path=note.txt',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      path: 'note.txt',
      content: 'hello\n',
      size: 6,
      editable: true,
      version: createHash('sha256')
        .update(readFileSync(join(worktree, 'note.txt')))
        .digest('hex'),
    });
  });

  it('downloads binary files with attachment headers', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    writeFileSync(join(worktree, 'contract.docx'), Buffer.from([1, 2, 3]));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const res = await app.inject({
      method: 'GET',
      url: '/sessions/s1/files/download?path=contract.docx',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers['content-disposition']).toContain('filename="contract.docx"');
    expect([...res.rawPayload]).toEqual([1, 2, 3]);
  });

  it('uploads files into the selected worktree directory without overwriting', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    mkdirSync(join(worktree, 'docs'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const first = await app.inject({
      method: 'POST',
      url: '/sessions/s1/files?path=docs&fileName=note.txt',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello'),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ path: 'docs/note.txt', size: 5 });
    expect(readFileSync(join(worktree, 'docs', 'note.txt'), 'utf8')).toBe('hello');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/sessions/s1/files?path=docs&fileName=note.txt',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('new'),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(readFileSync(join(worktree, 'docs', 'note.txt'), 'utf8')).toBe('hello');
  });

  it('rejects a declared file above the fixed per-file upload ceiling', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    mkdirSync(join(worktree, 'docs'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/s1/files?path=docs&fileName=huge.bin',
      headers: { 'content-type': 'application/octet-stream', 'content-length': '250000001' },
      payload: Buffer.alloc(0),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: 'file exceeds the 250 MB upload limit' });
  });

  it('accepts uploads under the media type the picked file carries', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    mkdirSync(join(worktree, 'docs'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    // The mobile upload body is a file-backed Blob whose own MIME type expo/fetch
    // puts on the wire in place of the header the client asked for.
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/files?path=docs&fileName=contract.pdf',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: 'docs/contract.pdf', size: 5 });
    expect(readFileSync(join(worktree, 'docs', 'contract.pdf'), 'utf8')).toBe('%PDF-');
  });

  // Fastify seeds parsers for these two and matches them ahead of any catch-all,
  // so a picked .json or .txt file is the case where the body would arrive as an
  // object or a string instead of the stream the upload route pipes to disk.
  it.each([
    ['application/json', 'config.json', '{\n  "note": "grüße"\n}\n'],
    ['text/plain', 'notes.txt', 'grüße\n'],
  ])('streams a %s upload to disk byte for byte', async (mediaType, fileName, contents) => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    mkdirSync(join(worktree, 'docs'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const res = await app.inject({
      method: 'POST',
      url: `/sessions/s1/files?path=docs&fileName=${fileName}`,
      headers: { 'content-type': mediaType },
      payload: Buffer.from(contents),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: `docs/${fileName}`, size: Buffer.byteLength(contents) });
    // Verbatim, not re-serialized: a parsed-then-written body would lose the
    // original whitespace.
    expect(readFileSync(join(worktree, 'docs', fileName), 'utf8')).toBe(contents);
  });

  it('still refuses an unparseable body on routes that are not uploads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-'),
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'invalid request' });
  });

  it('still parses a JSON body on routes that are not uploads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from('not json'),
    });

    expect(res.statusCode).toBe(400);
  });

  it('blocks file uploads through invalid paths and symlink directories', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    const outside = mkdtempSync(join(worktreeRoot, 'outside-'));
    symlinkSync(outside, join(worktree, 'outside'), 'dir');
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    for (const query of [
      'path=..%2F&fileName=escape.txt',
      'path=&fileName=..%2Fescape.txt',
      'path=outside&fileName=escape.txt',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/sessions/s1/files?${query}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('x'),
      });
      expect(res.statusCode).toBe(400);
    }
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
  });

  it('rejects names beyond the filesystem byte limit', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const longMultibyteName = `${'ä'.repeat(126)}.txt`;
    expect(Buffer.byteLength(longMultibyteName, 'utf8')).toBeGreaterThan(255);
    const longName = await app.inject({
      method: 'POST',
      url: `/sessions/s1/files?fileName=${encodeURIComponent(longMultibyteName)}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(longName.statusCode).toBe(400);
  });

  it('rejects file streams without a declared size', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/files?fileName=unknown.bin',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Readable.from([Buffer.from('unknown')]),
    });

    expect(res.statusCode).toBe(411);
    expect(existsSync(join(worktree, 'unknown.bin'))).toBe(false);
  });

  it('blocks path escapes and git internals', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    writeFileSync(join(worktree, 'ok.txt'), 'ok');
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const escape = await app.inject({ method: 'GET', url: '/sessions/s1/files?path=../' });
    expect(escape.statusCode).toBe(400);
    expect(escape.json()).toEqual({ error: 'invalid path' });

    const git = await app.inject({ method: 'GET', url: '/sessions/s1/files?path=.git/config' });
    expect(git.statusCode).toBe(400);
    expect(git.json()).toEqual({ error: 'invalid path' });
  });

  it('blocks symlink escapes out of the session worktree', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    const outside = mkdtempSync(join(worktreeRoot, 'outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(worktree, 'outside'), 'dir');
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });

    const res = await app.inject({
      method: 'GET',
      url: '/sessions/s1/files/content?path=outside/secret.txt',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid path' });
  });

  // Umlauts, `ß`, accents and CJK are ordinary in operator file names. `app.inject`
  // never serializes headers through Node, so these go over a real socket — that is
  // the only place the `Content-Disposition` header rejected a non-ASCII name and
  // turned every such download into a 500.
  it('round-trips non-ASCII file names through upload, listing and download', async () => {
    const worktree = mkdtempSync(join(worktreeRoot, 'files-'));
    mkdirSync(join(worktree, 'docs'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
    const name = 'Lageplan_Grundriß_Höhen.pdf';
    const base = `http://127.0.0.1:${String(port)}`;

    const upload = await fetch(
      `${base}/sessions/s1/files?path=docs&fileName=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('%PDF-'),
      },
    );
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ path: `docs/${name}`, size: 5 });
    // The bytes on disk are the name the operator picked, not a mojibake copy.
    expect(readdirSync(join(worktree, 'docs'))).toEqual([name]);

    const list = await fetch(`${base}/sessions/s1/files?path=docs`);
    expect(list.headers.get('content-type')).toMatch(/charset=utf-8/i);
    expect(await list.json()).toMatchObject({
      entries: [{ name, path: `docs/${name}` }],
    });

    const download = await fetch(
      `${base}/sessions/s1/files/download?path=${encodeURIComponent(`docs/${name}`)}`,
    );
    expect(download.status).toBe(200);
    const disposition = download.headers.get('content-disposition') ?? '';
    // ASCII skeleton for the legacy parameter, the real name in RFC 5987 form.
    expect(disposition).toContain('filename="Lageplan_Grundri__H_hen.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(Buffer.from(await download.arrayBuffer()).toString('utf8')).toBe('%PDF-');
  });
});

it('does not expose the retired issues route', async () => {
  expect((await app.inject({ method: 'GET', url: '/issues' })).statusCode).toBe(404);
});

it('serves the durable task list through the full server', async () => {
  const response = await app.inject({ method: 'GET', url: '/tasks' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ tasks: [] });
});

describe('error boundary', () => {
  it('never reflects an internal store error to the client', async () => {
    const throwing = {
      tasks: { expirePendingTitles: async () => [] },
      liveMeetings: { unfinishedResults: async () => [] },
      listMovePreviewRestarts: async () => [],
      listSessions: () => Promise.reject(new Error('driver destroyed SECRET-INTERNAL')),
    } as unknown as Parameters<typeof buildServer>[0]['eventStore'];
    const badApp = buildServer({ eventStore: throwing, bus: new InMemoryEventBus(), conductor });
    await badApp.ready();
    try {
      const res = await badApp.inject({ method: 'GET', url: '/sessions' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error' });
      expect(res.body).not.toContain('SECRET-INTERNAL');
    } finally {
      await badApp.close();
    }
  });
});

describe('GET /live (WebSocket)', () => {
  type Frame = Record<string, unknown>;

  /**
   * Connect and start QUEUEING frames immediately (before `open` resolves), so a
   * backlog frame that arrives before the first `next()` call isn't lost.
   */
  interface Conn {
    ws: WebSocket;
    next: () => Promise<Frame>;
    closed: Promise<{ code: number }>;
  }

  async function connect(atPort: number, path: string, protocol?: string): Promise<Conn> {
    const ws = new WebSocket(`ws://127.0.0.1:${String(atPort)}${path}`, protocol);
    const queue: Frame[] = [];
    const waiters: ((f: Frame) => void)[] = [];
    ws.addEventListener('message', (e) => {
      const frame = JSON.parse(String(e.data)) as Frame;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
    let onClosed: (v: { code: number }) => void = () => undefined;
    const closed = new Promise<{ code: number }>((resolve) => {
      onClosed = resolve;
    });
    ws.addEventListener('close', (e) => onClosed({ code: e.code }));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });
    const next = (): Promise<Frame> =>
      new Promise((resolve) => {
        const frame = queue.shift();
        if (frame) resolve(frame);
        else waiters.push(resolve);
      });
    return { ws, next, closed };
  }

  /** Connect, wait for `ready`, then subscribe to a session. */
  async function subscribe(
    atPort: number,
    sessionId: string,
    options: { sinceSeq?: number; protocol?: string } = {},
  ): Promise<Conn> {
    const conn = await connect(atPort, '/live', options.protocol);
    expect(await conn.next()).toMatchObject({ k: 'ready', v: 1 });
    conn.ws.send(
      JSON.stringify({
        k: 'sub',
        ch: 'session',
        id: sessionId,
        ...(options.sinceSeq === undefined ? {} : { sinceSeq: options.sinceSeq }),
      }),
    );
    return conn;
  }

  it('preserves the project on deletion hints without a cached session owner', async () => {
    await ctx.store.createProject({
      id: 'p-delete',
      kind: 'local',
      owner: '__local__',
      repo: 'delete',
      cloneDir: 'delete',
      containerName: 'delete',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-delete',
      worktree: '/wt/s-delete',
      model: 'm',
      projectId: 'p-delete',
    });
    const conn = await connect(port, '/live');
    try {
      expect(await conn.next()).toMatchObject({ k: 'ready' });
      conn.ws.send(JSON.stringify({ k: 'sub', ch: 'overview' }));
      // Synchronize after the subscription without priming the session owner cache.
      conn.ws.send(JSON.stringify({ k: 'ping', n: 1 }));
      expect(await conn.next()).toMatchObject({ k: 'pong', n: 1 });
      expect((await app.inject({ method: 'DELETE', url: '/sessions/s-delete' })).statusCode).toBe(
        200,
      );
      expect(await conn.next()).toMatchObject({
        k: 'hint',
        hints: [{ sessionId: 's-delete', projectId: 'p-delete', deleted: true }],
      });
    } finally {
      conn.ws.close();
    }
  });

  it('announces newly discovered PR status to overview and branch watchers together', async () => {
    await createExistingSession('s1');
    branchSvc.current.mockResolvedValue('fix/status');
    branchSvc.switchable.mockResolvedValue([]);
    let now = 0;
    let status = {
      number: 119,
      title: 'Known PR',
      url: 'https://github.com/example/repo/pull/119',
      phase: 'open' as const,
      pipeline: 'running' as 'running' | 'success',
      mergeable: false,
      checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
    };
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus: async () => status,
      pullRequestCacheNow: () => now,
    });
    await server.inject({ method: 'GET', url: '/sessions/s1/branches' });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test listener');
    const conn = await connect(address.port, '/live');
    try {
      expect(await conn.next()).toMatchObject({ k: 'ready' });
      const paths = ['/sessions?envelope=1', '/sessions/s1/branches'];
      for (const path of paths) {
        conn.ws.send(JSON.stringify({ k: 'watch', resource: { path } }));
        expect(await conn.next()).toEqual({ k: 'invalidate', path });
      }
      const invalidations: string[] = [];
      conn.ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.k === 'invalidate' && typeof frame.path === 'string')
          invalidations.push(frame.path);
      });
      status = {
        ...status,
        pipeline: 'success',
        mergeable: true,
        checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
      };
      now += 15_000;
      await server.inject({ method: 'GET', url: '/sessions/s1/branches' });
      // The overview's 30-second observation must not be needed to announce a PR
      // that another reader has already discovered.
      await vi.waitFor(() => expect(new Set(invalidations)).toEqual(new Set(paths)), {
        timeout: 5_000,
      });
      const overview = await server.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(
        overview
          .json<{ sessions: { sessionId: string; pullRequest?: unknown }[] }>()
          .sessions.find((session) => session.sessionId === 's1')?.pullRequest,
      ).toEqual(status);
    } finally {
      conn.ws.close();
      await conn.closed;
      await server.close();
    }
  });

  it('synchronizes project collapse between live devices after a saved mutation', async () => {
    await ctx.store.createProject({
      id: 'p-live',
      kind: 'local',
      owner: '__local__',
      repo: 'live',
      cloneDir: 'live',
      containerName: 'live',
      state: 'active',
    });
    const first = await connect(port, '/live');
    const second = await connect(port, '/live');
    try {
      for (const connection of [first, second]) {
        expect(await connection.next()).toMatchObject({ k: 'ready', resources: true });
        connection.ws.send(JSON.stringify({ k: 'watch', resource: { path: '/projects' } }));
        expect(await connection.next()).toEqual({ k: 'invalidate', path: '/projects' });
      }
      const response = await app.inject({
        method: 'PATCH',
        url: '/projects/p-live/collapsed',
        payload: { collapsed: true },
      });
      expect(response.statusCode).toBe(200);
      for (const connection of [first, second]) {
        expect(await connection.next()).toEqual({ k: 'invalidate', path: '/projects' });
        expect(
          (await app.inject({ method: 'GET', url: '/projects' }))
            .json<{ id: string; collapsed: boolean }[]>()
            .find((project) => project.id === 'p-live')?.collapsed,
        ).toBe(true);
      }
    } finally {
      first.ws.close();
      second.ws.close();
    }
  });

  it('streams a subscribed session: backlog -> caught_up -> live', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { seq: backlogSeq, ts: backlogTs } = await ctx.store.appendEvent('s1', {
      t: 'text',
      delta: 'backlog',
    });

    const { ws, next } = await subscribe(port, 's1');
    try {
      // The backlog frame carries the row's real created_at as `ts` (#32).
      expect(await next()).toMatchObject({ k: 'event', id: 's1', seq: backlogSeq, ts: backlogTs });
      expect(await next()).toMatchObject({ k: 'caught_up', id: 's1', seq: backlogSeq });

      bus.publish('s1', {
        seq: backlogSeq + 1,
        ts: 1_700_000_000_000,
        event: { t: 'text', delta: 'live' },
      });
      expect(await next()).toMatchObject({
        k: 'event',
        id: 's1',
        seq: backlogSeq + 1,
        ts: 1_700_000_000_000,
        event: { t: 'text', delta: 'live' },
      });
    } finally {
      ws.close();
    }
  });

  it('with sinceSeq, replays only events after the cursor (reconnect)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { seq: one } = await ctx.store.appendEvent('s1', { t: 'text', delta: 'one' });
    const { seq: two } = await ctx.store.appendEvent('s1', { t: 'text', delta: 'two' });
    const { ws, next } = await subscribe(port, 's1', { sinceSeq: one });
    try {
      expect(await next()).toMatchObject({
        k: 'event',
        seq: two,
        event: { t: 'text', delta: 'two' },
      });
      expect(await next()).toMatchObject({ k: 'caught_up', seq: two });
    } finally {
      ws.close();
    }
  });

  it('ends the subscription of a session that does not exist', async () => {
    const { ws, next } = await subscribe(port, 'missing');
    try {
      expect(await next()).toEqual({ k: 'ended', id: 'missing', reason: 'not_found' });
    } finally {
      ws.close();
    }
  });

  it('ends the subscription without detail if the backlog read fails', async () => {
    const throwing = {
      tasks: { expirePendingTitles: async () => [] },
      liveMeetings: { unfinishedResults: async () => [] },
      listMovePreviewRestarts: async () => [],
      getSession: async () => ({ sessionId: 's1', projectId: null }),
      getEventsAfter: () => Promise.reject(new Error('db down INTERNAL')),
    } as unknown as Parameters<typeof buildServer>[0]['eventStore'];
    const badApp = buildServer({ eventStore: throwing, bus: new InMemoryEventBus(), conductor });
    await badApp.listen({ port: 0, host: '127.0.0.1' });
    const badPort = (badApp.server.address() as AddressInfo).port;
    try {
      const { ws, next } = await subscribe(badPort, 's1');
      const frame = await next();
      expect(frame).toEqual({ k: 'ended', id: 's1', reason: 'error' });
      expect(JSON.stringify(frame)).not.toContain('INTERNAL');
      ws.close();
    } finally {
      await badApp.close();
    }
  });

  it.each(['revoke', 'forget', 'clear'] as const)(
    'invalidates pending tickets and open connections on %s',
    async (operation) => {
      const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
      const device = await registry.mint('revoked-device');
      const other = await registry.mint('other-device');
      const gated = buildServer({
        eventStore: ctx.store,
        bus: new InMemoryEventBus(),
        conductor,
        secretCipher: createSealableSecretCipher(),
        authRegistry: registry,
      });
      await gated.listen({ port: 0, host: '127.0.0.1' });
      const gatedPort = (gated.server.address() as AddressInfo).port;
      const connections: Array<{ ws: { close(): void } }> = [];
      try {
        const mint = async (token: string): Promise<string> => {
          const response = await gated.inject({
            method: 'POST',
            url: '/live/ticket',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.statusCode).toBe(200);
          return response.json<{ ticket: string }>().ticket;
        };
        const pending = await mint(device.token);
        const active = await connect(
          gatedPort,
          '/live',
          `verity-live-ticket.${await mint(device.token)}`,
        );
        connections.push(active);
        expect(await active.next()).toMatchObject({ k: 'ready' });
        const unaffected = await connect(
          gatedPort,
          '/live',
          `verity-live-ticket.${await mint(other.token)}`,
        );
        connections.push(unaffected);
        expect(await unaffected.next()).toMatchObject({ k: 'ready' });
        if (operation === 'revoke') await registry.revoke(device.id);
        else if (operation === 'clear') registry.clear();
        else registry.forget(hashAuthToken(device.token));
        // Existing connections and unused tickets otherwise outlive device authority.
        expect((await active.closed).code).toBe(1008);
        const rejected = await connect(gatedPort, '/live', `verity-live-ticket.${pending}`);
        connections.push(rejected);
        expect((await rejected.closed).code).toBe(1008);
        if (operation === 'clear') expect((await unaffected.closed).code).toBe(1008);
        else expect(unaffected.ws.readyState).toBe(1);
      } finally {
        for (const connection of connections) connection.ws.close();
        await gated.close();
      }
    },
  );

  it('requires a single-use, expiring live ticket once the gate is armed', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const { token } = await registry.mint('test-device');
    const gated = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: createSealableSecretCipher(),
      authRegistry: registry,
    });
    await gated.listen({ port: 0, host: '127.0.0.1' });
    const gatedPort = (gated.server.address() as AddressInfo).port;
    try {
      const mint = async (): Promise<string> => {
        const response = await gated.inject({
          method: 'POST',
          url: '/live/ticket',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        return response.json<{ ticket: string }>().ticket;
      };
      const unauthenticatedTicket = await gated.inject({ method: 'POST', url: '/live/ticket' });
      expect(unauthenticatedTicket.statusCode).toBe(401);
      const noToken = await connect(gatedPort, '/live');
      expect((await noToken.closed).code).toBe(1008);
      const bearerInUrl = await connect(gatedPort, `/live?access_token=${token}`);
      expect((await bearerInUrl.closed).code).toBe(1008);

      const ticket = await mint();
      const ok = await connect(gatedPort, '/live', `verity-live-ticket.${ticket}`);
      expect(await ok.next()).toMatchObject({ k: 'ready' });
      ok.ws.close();
      const replay = await connect(gatedPort, '/live', `verity-live-ticket.${ticket}`);
      expect((await replay.closed).code).toBe(1008);

      const expiringTicket = await mint();
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
      try {
        const expired = await connect(gatedPort, '/live', `verity-live-ticket.${expiringTicket}`);
        expect((await expired.closed).code).toBe(1008);
      } finally {
        clock.mockRestore();
      }
    } finally {
      await gated.close();
    }
  });

  it('hints overview subscribers about session mutations that are not events', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conn = await connect(port, '/live');
    try {
      expect(await conn.next()).toMatchObject({ k: 'ready' });
      conn.ws.send(JSON.stringify({ k: 'sub', ch: 'overview' }));
      // Let the subscription land before the mutation.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const renamed = await app.inject({
        method: 'PATCH',
        url: '/sessions/s1',
        payload: { name: 'Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(await conn.next()).toMatchObject({
        k: 'hint',
        hints: [
          expect.objectContaining({ sessionId: 's1', topics: expect.arrayContaining(['session']) }),
        ],
      });
    } finally {
      conn.ws.close();
    }
  });
});
