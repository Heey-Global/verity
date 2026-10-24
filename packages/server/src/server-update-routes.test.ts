import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthTokenRegistry } from './auth.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import {
  RELEASE_CHANNEL_SCHEMA_VERSION,
  type ReleaseChannelMetadata,
  type ServerUpdateAvailability,
} from './self-update/release-channel.js';
import { UPDATER_STALL_MS, type UpdateAttempt } from './self-update/update-attempt.js';
import type { UpdateOperation } from './self-update/update-operation.js';
import { UpdaterRequestError } from './self-update/updater-status.js';
import { registerServerUpdateRoutes, type ServerUpdateController } from './server-update-routes.js';

const digest = (character: string) =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const release: ReleaseChannelMetadata = {
  schemaVersion: RELEASE_CHANNEL_SCHEMA_VERSION,
  channel: 'stable',
  version: '4.52.1',
  revision: 'e'.repeat(40),
  architecture: 'amd64',
  serverImage: digest('c'),
  agentSeedImage: `ghcr.io/heey-global/verity/verity-agent-seed@sha256:${'d'.repeat(64)}`,
  compatibility: SERVER_COMPAT,
  publishedAt: '2026-10-21T00:00:00.000Z',
  generation: '2026-10-21T00:00:00.000Z',
};
const available: ServerUpdateAvailability = { state: 'available', release, operation: null };

/** The production case: committed 4.52.0, companion step stopped since yesterday. */
const stuck: UpdateOperation = {
  updateId: 'update-155',
  state: 'activating',
  phase: 'reconciling-companions',
  step: 15,
  totalSteps: 16,
  generation: 155,
  previousDigest: digest('a'),
  targetDigest: digest('b'),
  failureCode: null,
  startedAt: '2026-10-20T21:31:00.000Z',
  updatedAt: new Date(NOW - UPDATER_STALL_MS - 1).toISOString(),
};
const attempt: UpdateAttempt = {
  updateId: 'update-155',
  failures: 12,
  lastAttemptAt: '2026-10-21T11:55:00.000Z',
  lastError: { phase: 'reconciling-companions', cause: 'network-timeout' },
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function routes(
  controller: Partial<ServerUpdateController> | undefined,
  availability: ServerUpdateAvailability = available,
) {
  const app = Fastify();
  apps.push(app);
  registerServerUpdateRoutes(app, {
    authRegistry: { isEnabled: () => true } as unknown as AuthTokenRegistry,
    serverUpdateResolver: { resolve: async () => availability },
    serverUpdateController:
      controller === undefined
        ? undefined
        : {
            readOperation: async () => null,
            requestUpdate: async () => stuck,
            ...controller,
          },
    serverVersion: '4.52.0',
    now: () => NOW,
  });
  return app;
}

const status = async (app: FastifyInstance) =>
  (await app.inject({ method: 'GET', url: '/server/updates' })).json<Record<string, unknown>>();

describe('GET /server/updates recovery fields', () => {
  it('offers both ways out of a stalled companion step when a newer release exists', async () => {
    const app = routes({
      readOperation: async () => stuck,
      readAttempt: async () => attempt,
      retryUpdate: async () => stuck,
    });
    expect(await status(app)).toMatchObject({
      state: 'available',
      operation: { updateId: 'update-155' },
      installed: { version: '4.52.0', generation: 155 },
      attempt,
      stalled: true,
      recovery: { retry: true, supersede: true },
    });
  });

  it('offers nothing while the operation is still moving', async () => {
    const moving = { ...stuck, updatedAt: new Date(NOW - 60_000).toISOString() };
    const app = routes({
      readOperation: async () => moving,
      readAttempt: async () => null,
      retryUpdate: async () => moving,
    });
    expect(await status(app)).toMatchObject({
      stalled: false,
      recovery: { retry: false, supersede: false },
    });
  });

  // Before commit only resuming may end the switch-over; the Updater would
  // refuse a supersede there, so offering it would be a button that fails.
  it('offers only a retry for an operation stalled before commit', async () => {
    const midSwitch = { ...stuck, phase: 'observing-candidate', step: 13 } as const;
    const app = routes({
      readOperation: async () => midSwitch,
      readAttempt: async () => null,
      retryUpdate: async () => midSwitch,
    });
    expect(await status(app)).toMatchObject({
      installed: { generation: null },
      recovery: { retry: true, supersede: false },
    });
  });

  // The Updater refuses to supersede `committed`; offering it would light the
  // badge and an Install button that can only answer 409.
  it('offers only a retry for an operation stalled in committed', async () => {
    const committed = { ...stuck, phase: 'committed', step: 14 } as const;
    const app = routes({
      readOperation: async () => committed,
      readAttempt: async () => null,
      retryUpdate: async () => committed,
    });
    expect(await status(app)).toMatchObject({ recovery: { retry: true, supersede: false } });
  });

  it('offers no supersede when the stuck target is still the newest release', async () => {
    const app = routes(
      {
        readOperation: async () => stuck,
        readAttempt: async () => null,
        retryUpdate: async () => stuck,
      },
      { state: 'current', release: { ...release, serverImage: digest('b') }, operation: null },
    );
    expect(await status(app)).toMatchObject({ recovery: { retry: true, supersede: false } });
  });

  // An Updater from before this change answers 404 to both new routes and
  // refuses any stuck journal with `operation-in-progress`. Offering either
  // action — or lighting the badge for one — would be a button that can only fail.
  it('offers no recovery through an Updater that predates it', async () => {
    const app = routes({
      readOperation: async () => stuck,
      readAttempt: async () => undefined,
      retryUpdate: async () => stuck,
    });
    expect(await status(app)).toMatchObject({
      attempt: null,
      stalled: true,
      recovery: { retry: false, supersede: false },
    });
  });

  // A failed read cannot tell a capable Updater from one that would refuse, so
  // it must not light buttons that may only answer 409.
  it('keeps reporting the operation but offers nothing when the attempt cannot be read', async () => {
    const app = routes({
      readOperation: async () => stuck,
      readAttempt: async () => {
        throw new Error('socket closed');
      },
      retryUpdate: async () => stuck,
    });
    expect(await status(app)).toMatchObject({
      operation: { updateId: 'update-155' },
      attempt: null,
      recovery: { retry: false, supersede: false },
    });
  });

  it('drops an attempt recorded for an earlier operation', async () => {
    const app = routes({
      readOperation: async () => stuck,
      readAttempt: async () => ({ ...attempt, updateId: 'update-154' }),
    });
    expect(await status(app)).toMatchObject({ attempt: null });
  });
});

describe('POST /server/updates/retry', () => {
  it('relays the retry for the named operation', async () => {
    const retried: string[] = [];
    const app = routes({
      retryUpdate: async (updateId) => {
        retried.push(updateId);
        return stuck;
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/server/updates/retry',
      payload: { updateId: 'update-155' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ operation: { updateId: 'update-155' } });
    expect(retried).toEqual(['update-155']);
  });

  it('relays a refusal for an operation that moved on', async () => {
    const app = routes({
      retryUpdate: async () => {
        throw new UpdaterRequestError(409, 'not-retryable');
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/server/updates/retry',
      payload: { updateId: 'update-155' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not-retryable' });
  });

  it('rejects malformed input and deployments that cannot retry', async () => {
    const app = routes({ retryUpdate: async () => stuck });
    const malformed = await app.inject({
      method: 'POST',
      url: '/server/updates/retry',
      payload: { updateId: '../journal', extra: 1 },
    });
    expect(malformed.statusCode).toBe(400);
    const unmanaged = routes(undefined);
    const res = await unmanaged.inject({
      method: 'POST',
      url: '/server/updates/retry',
      payload: { updateId: 'update-155' },
    });
    expect(res.statusCode).toBe(503);
  });
});
