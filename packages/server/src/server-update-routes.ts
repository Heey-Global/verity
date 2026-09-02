import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthTokenRegistry } from './auth.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import type { ReleaseChannelResolver } from './self-update/release-channel.js';
import type { UpdateOperation } from './self-update/update-operation.js';
import { UpdaterRequestError } from './self-update/updater-status.js';

/**
 * Narrow view of the privileged Updater the Server is allowed to drive: read the
 * current operation, or request exactly one digest-pinned update. The Server
 * never learns Docker verbs, journal paths, or container identities.
 */
export interface ServerUpdateController {
  readOperation(): Promise<UpdateOperation | null>;
  requestUpdate(input: {
    readonly idempotencyKey: string;
    readonly targetDigest: string;
  }): Promise<UpdateOperation>;
}

export interface ServerUpdateRouteDeps {
  authRegistry?: AuthTokenRegistry | undefined;
  serverUpdateResolver?: ReleaseChannelResolver | undefined;
  serverUpdateController?: ServerUpdateController | undefined;
}

// Mirrors the Updater's own request contract so a malformed body is refused
// here instead of costing a round trip over the privileged control socket.
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

  // The resolver accepts only signed, official, digest-pinned channel metadata;
  // the operation is the Updater's own journal projection, never local guesswork.
  app.get('/server/updates', async (_request, reply) => {
    const availability = (await deps.serverUpdateResolver?.resolve()) ?? {
      state: 'unsupported' as const,
      reason: 'deployment is not managed',
      operation: null,
    };
    if (deps.serverUpdateController === undefined) return availability;
    try {
      return { ...availability, operation: await deps.serverUpdateController.readOperation() };
    } catch {
      // An unreachable Updater must not look reassuringly idle.
      return reply.code(503).send({ error: 'update status is unavailable' });
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
