import Fastify from 'fastify';
import rateLimitPlugin from '@fastify/rate-limit';
import { z } from 'zod';
import { BackupDeviceReview } from './device-review.js';

export interface RestoreTrialAdapters {
  review: BackupDeviceReview;
  /** Validate the sealed store's master-password verifier without unlocking its cipher. */
  authenticate(password: string): Promise<boolean>;
  inventory(): Promise<{ devices: string[]; revokedIds: string[]; findings: string[] }>;
  removeOtherTokens(allowed: readonly string[]): Promise<void>;
}

/** Listen only on an installer-owned Unix socket. No ordinary server modules are initialized. */
export function createRestoreTrial(adapters: RestoreTrialAdapters, now = Date.now) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  app.register(rateLimitPlugin, {
    global: true,
    max: 30,
    timeWindow: 60000,
    keyGenerator: () => 'installer',
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 429)
      return void reply.code(429).send({ error: 'Recovery request rate limited' });
    void reply.code(500).send({ error: 'Recovery operation failed' });
  });
  app.after(() => {
    let authenticating = false;
    let nextAttempt = 0;
    app.addHook('onRequest', (_request, reply, done) => {
      reply.header('Cache-Control', 'no-store');
      done();
    });
    app.get('/health', () => Promise.resolve({ mode: 'recovery-trial' }));
    app.post(
      '/recovery/authenticate',
      { config: { rateLimit: { max: 30, timeWindow: 60000 } } },
      async (request, reply) => {
        const parsed = z
          .object({ password: z.string().min(1).max(4096) })
          .strict()
          .safeParse(request.body);
        request.body = undefined;
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid recovery request' });
        if (authenticating || now() < nextAttempt)
          return reply.code(429).send({ error: 'Recovery authentication rate limited' });
        authenticating = true;
        nextAttempt = now() + 5000;
        try {
          if (!(await adapters.authenticate(parsed.data.password)))
            return reply.code(401).send({ error: 'Recovery authentication failed' });
          const current = await adapters.review.load();
          if (current?.status === 'complete')
            return reply.code(409).send({ error: 'Device review already complete' });
          const inventory = await adapters.inventory();
          const token = await adapters.review.create(
            inventory.devices,
            inventory.revokedIds,
            inventory.findings,
          );
          return { token };
        } finally {
          parsed.data.password = '';
          authenticating = false;
        }
      },
    );
    const session = (header: string | undefined): string => {
      if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return '';
      return header.slice(7);
    };
    app.get('/recovery/devices', async (request, reply) => {
      try {
        return await adapters.review.inspect(session(request.headers.authorization));
      } catch {
        return reply.code(401).send({ error: 'Invalid recovery session' });
      }
    });
    app.post('/recovery/devices', async (request, reply) => {
      const parsed = z
        .object({ keepIds: z.array(z.string().min(1).max(256)).max(10000) })
        .strict()
        .safeParse(request.body);
      request.body = undefined;
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid device review' });
      try {
        await adapters.review.accept(
          session(request.headers.authorization),
          parsed.data.keepIds,
          (allowed) => adapters.removeOtherTokens(allowed),
        );
        return { reviewed: true };
      } catch {
        return reply.code(403).send({ error: 'Device review rejected' });
      }
    });
  });
  return app;
}
