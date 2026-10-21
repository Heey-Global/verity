import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthTokenRegistry } from './auth.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import { runtimeServerVersion } from './runtime-version.js';
import type {
  ReleaseChannelResolver,
  ServerUpdateAvailability,
} from './self-update/release-channel.js';
import {
  SUPERSEDABLE_PHASES,
  UPDATE_ID_PATTERN,
  isStalledOperation,
  type UpdateAttempt,
} from './self-update/update-attempt.js';
import { isTerminalOperationState, type UpdateOperation } from './self-update/update-operation.js';
import { UpdaterRequestError } from './self-update/updater-status.js';

/**
 * Narrow view of the privileged Updater the Server is allowed to drive: read the
 * current operation, or request exactly one digest-pinned update. The Server
 * never learns Docker verbs, journal paths, or container identities.
 */
export interface ServerUpdateController {
  readChannel?(): Promise<'stable' | 'staging'>;
  setChannel?(channel: 'stable' | 'staging'): Promise<'stable' | 'staging'>;
  readOperation(): Promise<UpdateOperation | null>;
  /** Why the operation's last attempt failed; `null` when nothing is recorded,
   *  `undefined` when the Updater predates the record (and with it, retry). */
  readAttempt?(): Promise<UpdateAttempt | null | undefined>;
  /** Resume the named unfinished operation now. Absent → no retry is offered. */
  retryUpdate?(updateId: string): Promise<UpdateOperation>;
  requestUpdate(input: {
    readonly idempotencyKey: string;
    readonly targetDigest: string;
    readonly channel?: 'stable' | 'staging';
  }): Promise<UpdateOperation>;
}

export interface ServerUpdateRouteDeps {
  authRegistry?: AuthTokenRegistry | undefined;
  serverUpdateResolver?: ReleaseChannelResolver | undefined;
  serverUpdateController?: ServerUpdateController | undefined;
  /** The running Server's release; defaults to the image's version stamp. */
  serverVersion?: string | undefined;
  /** Clock for the stall rule; defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

/** Phases in which the running Server is the operation's target generation. */
const PROMOTED_PHASES: readonly string[] = ['committed', 'reconciling-companions', 'completed'];

/**
 * What the device needs beyond availability and the operation: what is running,
 * why the operation stopped, and which way out the Server will accept.
 *
 * Additive on purpose. Every field is new, so an app that predates them keeps
 * parsing the payload, and an app talking to an older Server sees them absent
 * and offers nothing it cannot do. `recovery` is decided here rather than in the
 * app so both actions follow the same stall rule as the attention banner.
 */
function describeRecovery(
  availability: ServerUpdateAvailability,
  operation: UpdateOperation | null,
  attempt: UpdateAttempt | null,
  options: { serverVersion: string; now: number; recoverable: boolean },
) {
  const stalled = operation !== null && isStalledOperation(operation, options.now);
  const pending = operation !== null && !isTerminalOperationState(operation.state);
  return {
    installed: {
      version: options.serverVersion,
      // Only a promoted operation tells which generation is serving; after a
      // failure or rollback the running one is an earlier, unrecorded one.
      generation:
        operation !== null && PROMOTED_PHASES.includes(operation.phase)
          ? operation.generation
          : null,
    },
    attempt: operation !== null && attempt?.updateId === operation.updateId ? attempt : null,
    stalled,
    recovery: {
      retry: pending && stalled && options.recoverable,
      supersede:
        options.recoverable &&
        operation !== null &&
        stalled &&
        SUPERSEDABLE_PHASES.includes(operation.phase) &&
        availability.state === 'available' &&
        availability.release.serverImage !== operation.targetDigest,
    },
  };
}

// Mirrors the Updater's own request contract so a malformed body is refused
// here instead of costing a round trip over the privileged control socket.
const serverUpdateRetryBody = z.object({ updateId: z.string().regex(UPDATE_ID_PATTERN) }).strict();

const serverUpdateRequestBody = z.object({
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
  targetDigest: z
    .string()
    .regex(/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/),
});

/** Compatibility, availability, and digest-pinned managed Server update routes. */
export function registerServerUpdateRoutes(
  app: FastifyInstance,
  deps: ServerUpdateRouteDeps,
): void {
  // Read-only compatibility surface this build advertises (ADR 0008 slice 1).
  // The global bearer gate protects it like any other authenticated route.
  app.get('/server/compat', () => SERVER_COMPAT);
  const serverVersion = deps.serverVersion ?? runtimeServerVersion();
  const now = deps.now ?? Date.now;

  app.get('/server/update-channel', async (_request, reply) => {
    if (!deps.serverUpdateController?.readChannel)
      return reply.code(503).send({ error: 'channel selection is unavailable' });
    try {
      return { channel: await deps.serverUpdateController.readChannel() };
    } catch {
      return reply.code(503).send({ error: 'channel selection is unavailable' });
    }
  });
  app.post('/server/update-channel', async (request, reply) => {
    if (!deps.authRegistry?.isEnabled())
      return reply.code(403).send({ error: 'channel changes require a paired device' });
    const parsed = z
      .object({ channel: z.enum(['stable', 'staging']) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid update channel' });
    const { channel } = parsed.data;
    if (!deps.serverUpdateController?.setChannel)
      return reply.code(503).send({ error: 'channel selection is unavailable' });
    try {
      return { channel: await deps.serverUpdateController.setChannel(channel) };
    } catch (error) {
      return reply
        .code(error instanceof UpdaterRequestError && error.status === 409 ? 409 : 503)
        .send({ error: 'channel change is unavailable' });
    }
  });

  // The resolver accepts only signed, official, digest-pinned channel metadata;
  // the operation is the Updater's own journal projection, never local guesswork.
  app.get('/server/updates', async (_request, reply) => {
    const availability = (await deps.serverUpdateResolver?.resolve()) ?? {
      state: 'unsupported' as const,
      reason: 'deployment is not managed',
      operation: null,
    };
    const controller = deps.serverUpdateController;
    // Without an Updater there is no operation to recover, only a version to show.
    if (controller === undefined)
      return { ...availability, installed: { version: serverVersion, generation: null } };
    let operation: UpdateOperation | null;
    try {
      operation = await controller.readOperation();
    } catch {
      // An unreachable Updater must not look reassuringly idle.
      return reply.code(503).send({ error: 'update status is unavailable' });
    }
    // Diagnostics only: an Updater that predates the record, or fails to read
    // it, still has a perfectly good operation to report.
    const attempt =
      operation === null || controller.readAttempt === undefined
        ? undefined
        : await controller.readAttempt().catch(() => null);
    return {
      ...availability,
      operation,
      ...describeRecovery(availability, operation, attempt ?? null, {
        serverVersion,
        now: now(),
        // Retry and supersede ship with the attempt route. An Updater without
        // it refuses both — it answers any stuck journal with
        // `operation-in-progress` — so offering either would be a dead button.
        recoverable: controller.retryUpdate !== undefined && attempt !== undefined,
      }),
    };
  });

  // Resume the current operation now — what an Updater restart would do, without
  // host access. 202 means the resume is queued or already running: the Updater
  // joins a run in progress and paces repeated requests, and the operation's
  // own status says what came of it. Bound to the operation's id so a stale screen cannot retry a
  // different one, and limited to paired devices like installing itself.
  app.post('/server/updates/retry', async (request, reply) => {
    const controller = deps.serverUpdateController;
    if (controller?.retryUpdate === undefined)
      return reply.code(503).send({ error: 'deployment is not managed' });
    const registry = deps.authRegistry;
    if (registry === undefined || !registry.isEnabled())
      return reply.code(403).send({ error: 'updates require a paired device' });
    const parsed = serverUpdateRetryBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid retry request' });
    try {
      const operation = await controller.retryUpdate(parsed.data.updateId);
      return reply.code(202).send({ operation });
    } catch (error) {
      if (error instanceof UpdaterRequestError && error.status === 409)
        return reply.code(409).send({ error: error.code });
      // 404 is an Updater that predates the route: it cannot retry, which is a
      // capability the device was told it has, so it reads as unavailable.
      return reply.code(503).send({ error: 'updater is unavailable' });
    }
  });

  // This action needs a paired device even when the ambient bearer gate is
  // disabled, and may request only the digest the signed channel currently offers.
  app.post('/server/updates', async (request, reply) => {
    const controller = deps.serverUpdateController;
    if (controller === undefined || deps.serverUpdateResolver === undefined) {
      return reply.code(503).send({ error: 'deployment is not managed' });
    }
    const registry = deps.authRegistry;
    if (registry === undefined || !registry.isEnabled()) {
      return reply.code(403).send({ error: 'updates require a paired device' });
    }
    const body = serverUpdateRequestBody.parse(request.body);
    const availability = await deps.serverUpdateResolver.resolve();
    if (availability.state !== 'available') {
      return reply.code(409).send({ error: `no update is available (${availability.state})` });
    }
    if (availability.release.serverImage !== body.targetDigest) {
      return reply.code(409).send({ error: 'target digest is not the available release' });
    }
    try {
      const operation = await controller.requestUpdate({
        idempotencyKey: body.idempotencyKey,
        targetDigest: body.targetDigest,
        channel: availability.release.channel,
      });
      return reply.code(202).send({ operation });
    } catch (error) {
      if (error instanceof UpdaterRequestError) {
        // Relay the Updater's closed outcome code; it carries no internal detail.
        return reply
          .code(error.status === 401 ? 503 : error.status)
          .send({ error: error.status === 401 ? 'updater is unavailable' : error.code });
      }
      return reply.code(503).send({ error: 'updater is unavailable' });
    }
  });
}
