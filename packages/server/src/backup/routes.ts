import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BackupService } from './service.js';

/** Enable only after the pinned-image, original-host-free acceptance suite passes. */
export const BACKUP_RECOVERY_ACCEPTED = false;
type BackupApi = Pick<
  BackupService,
  | 'status'
  | 'beginSetup'
  | 'confirmSetup'
  | 'cancelSetup'
  | 'beginKeyReplacement'
  | 'confirmKeyReplacement'
  | 'cancelKeyReplacement'
  | 'setPolicy'
  | 'startProbe'
  | 'probeStatus'
  | 'cancelProbe'
>;
export interface BackupRouteDependencies {
  userId: (request: FastifyRequest) => string | null;
  isAdministrator: (userId: string) => Promise<boolean>;
  recoveryAccepted: () => boolean;
  service?: BackupApi | undefined;
  unavailableReason?: () => 'installer-required' | 'runtime-unavailable';
}
const confirmation = z
  .object({ id: z.string().uuid(), recoveryKey: z.string().min(1).max(4096) })
  .strict();
const policy = z
  .object({
    paused: z.boolean().optional(),
    intervalMs: z.number().int().min(3600000).max(86400000).optional(),
  })
  .strict()
  .refine((value) => value.paused !== undefined || value.intervalMs !== undefined);
const probeRequest = z.object({ recoveryKey: z.string().min(1).max(4096) }).strict();
const probeId = z.object({ id: z.string().uuid() }).strict();

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDependencies): void {
  void app.register((app, _options, done) => {
    app.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const userId = deps.userId(request);
      if (!userId) return reply.code(404).send({ error: 'not found' });
      if (!(await deps.isAdministrator(userId)))
        return reply.code(403).send({ error: 'administrator required' });
      if (
        request.routeOptions.url !== '/api/backups/status' &&
        (!deps.recoveryAccepted() || !deps.service)
      )
        return reply.code(503).send({ error: 'backups unavailable' });
    });
    const execute = async <T>(
      reply: FastifyReply,
      action: () => Promise<T>,
    ): Promise<T | { error: string }> => {
      try {
        return await action();
      } catch {
        reply.code(409);
        return { error: 'backup operation failed' };
      }
    };
    app.get('/api/backups/status', async (_request, reply) => {
      if (!deps.recoveryAccepted())
        return { available: false, reason: 'recovery-validation-pending' };
      if (!deps.service)
        return { available: false, reason: deps.unavailableReason?.() ?? 'installer-required' };
      return execute(reply, async () => ({ available: true, ...(await deps.service!.status()) }));
    });
    app.post('/api/backups/setup', { bodyLimit: 16384 }, async (_request, reply) =>
      execute(reply, () => deps.service!.beginSetup()),
    );
    app.post('/api/backups/setup/confirm', { bodyLimit: 16384 }, async (request, reply) => {
      const body = confirmation.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid backup confirmation' });
      return execute(reply, async () => {
        await deps.service!.confirmSetup(body.data.id, body.data.recoveryKey);
        return { ok: true };
      });
    });
    app.post('/api/backups/setup/cancel', { bodyLimit: 16384 }, async (_request, reply) =>
      execute(reply, async () => {
        await deps.service!.cancelSetup();
        return { ok: true };
      }),
    );
    app.post('/api/backups/key-replacement', { bodyLimit: 16384 }, async (request, reply) => {
      const body = z
        .object({ reason: z.enum(['lost', 'exposed']) })
        .strict()
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid replacement request' });
      return execute(reply, () => deps.service!.beginKeyReplacement(body.data.reason));
    });
    app.post(
      '/api/backups/key-replacement/confirm',
      { bodyLimit: 16384 },
      async (request, reply) => {
        const body = confirmation.safeParse(request.body);
        request.body = undefined;
        if (!body.success) return reply.code(400).send({ error: 'invalid backup confirmation' });
        return execute(reply, async () => {
          try {
            await deps.service!.confirmKeyReplacement(body.data.id, body.data.recoveryKey);
          } finally {
            body.data.recoveryKey = '';
          }
          return { ok: true };
        });
      },
    );
    app.post('/api/backups/key-replacement/cancel', { bodyLimit: 16384 }, async (_request, reply) =>
      execute(reply, async () => {
        await deps.service!.cancelKeyReplacement();
        return { ok: true };
      }),
    );
    app.patch('/api/backups/policy', { bodyLimit: 16384 }, async (request, reply) => {
      const body = policy.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid backup policy' });
      return execute(reply, async () => {
        await deps.service!.setPolicy({
          ...(body.data.paused !== undefined ? { paused: body.data.paused } : {}),
          ...(body.data.intervalMs !== undefined ? { intervalMs: body.data.intervalMs } : {}),
        });
        return { ok: true };
      });
    });
    app.post('/api/backups/probes', { bodyLimit: 16384 }, async (request, reply) => {
      const body = probeRequest.safeParse(request.body);
      // Do not retain the submitted secret in the request object after dispatch.
      request.body = undefined;
      if (!body.success) return reply.code(400).send({ error: 'invalid probe request' });
      return execute(reply, async () => {
        const pending = deps.service!.startProbe(body.data.recoveryKey);
        body.data.recoveryKey = '';
        const job = await pending;
        reply.code(202);
        return job;
      });
    });
    app.get('/api/backups/probes/:id', async (request, reply) => {
      const params = probeId.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid probe id' });
      const job = deps.service!.probeStatus(params.data.id);
      return job ?? reply.code(404).send({ error: 'probe not found' });
    });
    app.post('/api/backups/probes/:id/cancel', { bodyLimit: 16384 }, async (request, reply) => {
      const params = probeId.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid probe id' });
      if (!deps.service!.probeStatus(params.data.id))
        return reply.code(404).send({ error: 'probe not found' });
      return execute(reply, () => deps.service!.cancelProbe(params.data.id));
    });
    done();
  });
}
