import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import {
  internalConnectionIdentity,
  internalConnectionGenerationSignal,
} from './internal-listener.js';

const inputSchema = z.object({
  action: z.enum(['check', 'configured']),
  sessionId: z.string().min(1).max(256),
  manager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv']),
  command: z.string().min(1).max(16_384),
  supported: z.boolean(),
  protected: z.boolean(),
  configFile: z.string().min(1).max(4096),
  setupToken: z.string().uuid().optional(),
});

interface SetupGrant {
  projectId: string;
  containerGeneration: string;
  sessionId: string;
  manager: string;
  configFile: string;
  expires: number;
}

export function registerPackageInstallRoute(
  app: FastifyInstance,
  deps: {
    capabilities?: GhTokenCapabilityRegistry | undefined;
    store: Pick<
      EventStore,
      'getSession' | 'getPackageProtectionDecision' | 'setPackageProtectionDecision'
    >;
    conductor: Pick<Conductor, 'requestExternalPermission'>;
    appendNotice: (sessionId: string, text: string) => Promise<void>;
  },
): void {
  if (!deps.capabilities) return;
  const capabilities = deps.capabilities;
  const queues = new Map<string, Promise<void>>();
  const setupSelections = new Set<string>();
  const grants = new Map<string, SetupGrant>();

  app.post('/internal/package-install', async (request, reply) => {
    const token = bearerToken(request.headers.authorization) ?? '';
    const binding = token === '' ? undefined : await capabilities.resolve(token);
    const socket = internalConnectionIdentity(request);
    if (
      !binding ||
      !socket ||
      socket.projectId !== binding.projectId ||
      socket.containerGeneration !== binding.containerGeneration
    )
      return reply.code(401).send({ error: 'unauthorized' });
    const generationSignal = internalConnectionGenerationSignal(request);
    const authorized = async (): Promise<boolean> => {
      if (generationSignal?.aborted) return false;
      const current = await capabilities.resolve(token);
      return (
        !generationSignal?.aborted &&
        current?.projectId === binding.projectId &&
        current.containerGeneration === binding.containerGeneration
      );
    };
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid package installation request' });
    const body = parsed.data;
    const session = await deps.store.getSession(body.sessionId);
    if (!session || session.projectId !== binding.projectId)
      return reply.code(404).send({ error: 'session not found in this project' });
    if (!(await authorized())) return reply.code(401).send({ error: 'unauthorized' });
    const projectId = binding.projectId;
    for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key);

    if (body.action === 'configured') {
      const grant = body.setupToken === undefined ? undefined : grants.get(body.setupToken);
      if (
        !grant ||
        grant.projectId !== projectId ||
        grant.containerGeneration !== binding.containerGeneration ||
        grant.sessionId !== body.sessionId ||
        grant.manager !== body.manager ||
        grant.configFile !== body.configFile ||
        !body.protected ||
        !body.supported
      )
        return reply.code(409).send({ error: 'no matching approved package protection setup' });
      await deps.store.setPackageProtectionDecision(projectId, 'protected');
      grants.delete(body.setupToken!);
      setupSelections.delete(projectId);
      await deps.appendNotice(body.sessionId, `3-day delay set up · ${basename(body.configFile)}`);
      if (!(await authorized())) return reply.code(401).send({ error: 'unauthorized' });
      return { action: 'continue' };
    }

    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    const closed = (): void => {
      if (!reply.raw.writableFinished) abort();
    };
    generationSignal?.addEventListener('abort', abort, { once: true });
    request.raw.once('aborted', abort);
    reply.raw.once('close', closed);
    const previous = queues.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const queued = previous.then(() => waiting);
    queues.set(projectId, queued);
    try {
      await previous;
      if (controller.signal.aborted || !(await authorized())) return { action: 'cancel' };
      const configure = (): { action: 'configure'; setupToken: string } => {
        const setupToken = randomUUID();
        grants.set(setupToken, {
          projectId,
          containerGeneration: socket.containerGeneration,
          sessionId: body.sessionId,
          manager: body.manager,
          configFile: body.configFile,
          expires: Date.now() + 10 * 60_000,
        });
        return { action: 'configure', setupToken };
      };
      const saved = await deps.store.getPackageProtectionDecision(projectId);
      if (controller.signal.aborted || !(await authorized())) return { action: 'cancel' };
      if (saved === 'skipped') return { action: 'continue' };
      // A stale file on an older CLI is not evidence the setting is effective.
      if (body.protected && body.supported) {
        await deps.store.setPackageProtectionDecision(projectId, 'protected');
        return { action: (await authorized()) ? 'continue' : 'cancel' };
      }
      if ((saved === 'protected' || setupSelections.has(projectId)) && body.supported)
        return configure();
      const answer = await deps.conductor.requestExternalPermission({
        sessionId: body.sessionId,
        toolUseId: `package-install-${randomUUID()}`,
        toolName: 'verity_package_install',
        input: {
          command: body.command,
          manager: body.manager,
          supported: body.supported,
          configFile: basename(body.configFile),
        },
        channel: 'acp',
        allowStandingGrant: false,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        !(await authorized()) ||
        answer.decision.behavior !== 'allow'
      )
        return { action: 'cancel' };
      const action = answer.decision.updatedInput?.action;
      if (body.supported && action === 'configure') {
        setupSelections.add(projectId);
        return configure();
      }
      if ((body.supported && action === 'skip') || (!body.supported && action === 'install')) {
        setupSelections.delete(projectId);
        for (const [key, grant] of grants) if (grant.projectId === projectId) grants.delete(key);
        await deps.store.setPackageProtectionDecision(projectId, 'skipped');
        await deps.appendNotice(
          body.sessionId,
          'Dependency release delay skipped · decision saved',
        );
        return { action: (await authorized()) ? 'continue' : 'cancel' };
      }
      return { action: 'cancel' };
    } finally {
      release();
      if (queues.get(projectId) === queued) queues.delete(projectId);
      generationSignal?.removeEventListener('abort', abort);
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', closed);
    }
  });
}
