import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  WorkflowAuthorizationError,
  WorkflowConflictError,
  WorkflowNotFoundError,
  type ProjectRecord,
  type SessionRecord,
  type WorkflowStore,
} from '@verity/store';
import { bearerToken, type AuthTokenRegistry } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { internalConnectionIdentity } from './internal-listener.js';

type WorkflowAction =
  | 'service:write'
  | 'workflow:create'
  | 'workflow:authorize'
  | 'step:dispatch'
  | 'workflow:cancel'
  | 'workflow:resume'
  | 'decision:approve'
  | 'artifact:propose'
  | 'workflow:read';

interface PullRequestIdentity {
  phase: string;
  number: number;
  headSha?: string | undefined;
}

export interface WorkflowRouteDeps {
  store?: WorkflowStore | undefined;
  authRegistry?: Pick<AuthTokenRegistry, 'resolveId'> | undefined;
  authorizeAction?:
    | ((
        actorId: string,
        action: WorkflowAction,
        scope: Record<string, unknown>,
      ) => Promise<boolean>)
    | undefined;
  getProject: (projectId: string) => Promise<ProjectRecord | undefined>;
  getSession: (sessionId: string) => Promise<SessionRecord | undefined>;
  stopSession: (sessionId: string) => Promise<unknown>;
  dispatchSession: (request: FastifyRequest, reply: FastifyReply) => Promise<string | undefined>;
  sessionPrStatus: (session: SessionRecord) => Promise<PullRequestIdentity | null>;
  capabilities?: GhTokenCapabilityRegistry | undefined;
  mergeConfigured: boolean;
  githubWebhookConfigured: boolean;
  githubWebhookDigest: (request: FastifyRequest) => Promise<string> | undefined;
}

const serviceBody = z.object({
  id: z.string().min(1).max(100),
  sourceProjectId: z.string().min(1),
  sourceRepository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  imageRepository: z.string().min(1),
  deployments: z.record(
    z.string().min(1),
    z.object({
      projectId: z.string().min(1),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      manifestPath: z
        .string()
        .min(1)
        .refine((path) => !path.startsWith('/') && !path.split('/').includes('..')),
      argoApplication: z.string().min(1),
    }),
  ),
});

const createBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  controlProjectId: z.string().min(1),
  rootSessionId: z.string().optional(),
  objective: z.string().min(1).max(10_000),
  environment: z.string().min(1).max(100),
  serviceId: z.string().min(1).max(100),
});

const versionBody = z.object({ version: z.number().int().positive() });
const decisionBody = z.object({
  version: z.number().int().positive(),
  stepId: z.string().min(1),
  approved: z.literal(true),
});
const imageBody = z.object({
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  version: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
});
const resultBody = z.object({
  handoffId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  capability: z.string().min(32).max(512),
  status: z.enum(['completed', 'blocked', 'failed', 'cancelled']),
  summary: z.string().min(1).max(4_000),
  outputs: z.record(z.string(), z.unknown()),
  evidence: z.array(z.unknown()).max(100),
  blocker: z.unknown().optional(),
});
const workflowParams = z.object({ id: z.string().min(1) });

function workflowError(error: unknown, reply: FastifyReply): { error: string } | undefined {
  if (error instanceof WorkflowNotFoundError) {
    reply.code(404);
    return { error: error.message };
  }
  if (error instanceof WorkflowConflictError) {
    reply.code(409);
    return { error: error.message };
  }
  if (error instanceof WorkflowAuthorizationError) {
    reply.code(403);
    return { error: error.message };
  }
  return undefined;
}

/** Registers the cross-project workflow API and its provider/result ingress routes. */
export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const actorFor = (request: FastifyRequest): { id: string; authorizationHash: string } => {
    const token = bearerToken(request.headers.authorization);
    const id = deps.authRegistry?.resolveId(token) ?? 'local-control-plane';
    return {
      id,
      authorizationHash: createHash('sha256')
        .update(`workflow-actor:${id}:${token ?? 'headless'}`)
        .digest('hex'),
    };
  };

  const requireAuthority = async (
    request: FastifyRequest,
    action: WorkflowAction,
    scope: Record<string, unknown>,
  ): Promise<{ id: string; authorizationHash: string }> => {
    const actor = actorFor(request);
    if ((await deps.authorizeAction?.(actor.id, action, scope)) !== true) {
      if (deps.store !== undefined && typeof scope.workflowId === 'string')
        await deps.store.recordPolicyDenial(
          scope.workflowId,
          action,
          actor,
          `not authorized to perform ${action}`,
        );
      throw new WorkflowAuthorizationError(`not authorized to perform ${action}`);
    }
    return actor;
  };

  const configured = (reply: FastifyReply): WorkflowStore | undefined => {
    if (deps.store !== undefined) return deps.store;
    reply.code(503);
    return undefined;
  };

  app.post('/providers/github/webhook', async (request, reply): Promise<unknown> => {
    if (deps.store === undefined || !deps.githubWebhookConfigured) {
      reply.code(404);
      return { error: 'not found' };
    }
    const supplied = request.headers['x-hub-signature-256'];
    const delivery = request.headers['x-github-delivery'];
    const eventType = request.headers['x-github-event'];
    const expected = await deps.githubWebhookDigest(request);
    if (
      typeof supplied !== 'string' ||
      !/^sha256=[0-9a-f]{64}$/u.test(supplied) ||
      typeof expected !== 'string' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      reply.code(401);
      return { error: 'invalid webhook signature' };
    }
    if (typeof delivery !== 'string' || delivery.length === 0 || delivery.length > 200) {
      reply.code(400);
      return { error: 'invalid delivery id' };
    }
    if (typeof eventType !== 'string' || eventType.length === 0 || eventType.length > 100) {
      reply.code(400);
      return { error: 'invalid event type' };
    }
    const supported = new Set(['pull_request', 'check_run', 'status', 'workflow_run', 'package']);
    if (!supported.has(eventType)) return { accepted: false };
    const accepted = await deps.store.ingestProviderEvent(
      'github',
      delivery,
      eventType,
      request.body,
    );
    reply.code(accepted ? 202 : 200);
    return { accepted };
  });

  app.post('/workflow-services', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const body = serviceBody.parse(request.body);
    try {
      await requireAuthority(request, 'service:write', {
        serviceId: body.id,
        sourceProjectId: body.sourceProjectId,
        deploymentProjectIds: Object.values(body.deployments).map(({ projectId }) => projectId),
      });
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
    const source = await deps.getProject(body.sourceProjectId);
    if (source === undefined) {
      reply.code(404);
      return { error: `source project ${body.sourceProjectId} not found` };
    }
    if (`${source.owner}/${source.repo}`.toLowerCase() !== body.sourceRepository.toLowerCase()) {
      reply.code(400);
      return { error: 'source repository does not match the registered project' };
    }
    for (const deployment of Object.values(body.deployments)) {
      const project = await deps.getProject(deployment.projectId);
      if (project === undefined) {
        reply.code(404);
        return { error: `deployment project ${deployment.projectId} not found` };
      }
      if (
        `${project.owner}/${project.repo}`.toLowerCase() !== deployment.repository.toLowerCase()
      ) {
        reply.code(400);
        return { error: 'deployment repository does not match the registered project' };
      }
    }
    await store.registerService(body);
    return { ok: true };
  });

  app.get('/workflows', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    try {
      await requireAuthority(request, 'workflow:read', {});
      return store.listWorkflows();
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const body = createBody.parse(request.body);
    try {
      const actor = await requireAuthority(request, 'workflow:create', {
        controlProjectId: body.controlProjectId,
        serviceId: body.serviceId,
        environment: body.environment,
      });
      const workflow = await store.createWorkflow({
        idempotencyKey: body.idempotencyKey,
        controlProjectId: body.controlProjectId,
        ...(body.rootSessionId !== undefined ? { rootSessionId: body.rootSessionId } : {}),
        objective: body.objective,
        environment: body.environment,
        serviceId: body.serviceId,
        actorId: actor.id,
      });
      reply.code(201);
      return workflow;
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.get('/workflows/:id', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id } = workflowParams.parse(request.params);
    try {
      await requireAuthority(request, 'workflow:read', { workflowId: id });
      return await store.getWorkflow(id);
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows/:id/authorize', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id } = workflowParams.parse(request.params);
    const { version } = versionBody.parse(request.body);
    try {
      const actor = await requireAuthority(request, 'workflow:authorize', { workflowId: id });
      return await store.authorizeWorkflow(id, version, actor);
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows/:id/steps/:stepId/dispatch', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id, stepId } = z
      .object({ id: z.string().min(1), stepId: z.string().min(1) })
      .parse(request.params);
    const { version } = versionBody.parse(request.body);
    try {
      const actor = await requireAuthority(request, 'step:dispatch', { workflowId: id, stepId });
      await store.queueDispatch(id, stepId, version, actor);
      const sessionId = await deps.dispatchSession(request, reply);
      reply.code(202);
      return { queued: true, ...(sessionId !== undefined ? { sessionId } : {}) };
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows/:id/cancel', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id } = workflowParams.parse(request.params);
    try {
      const actor = await requireAuthority(request, 'workflow:cancel', { workflowId: id });
      const activeSessionIds = await store.listActiveWorkflowSessionIds(id);
      const cancelled = await store.cancelWorkflow(id, actor.id);
      await Promise.allSettled(activeSessionIds.map((sessionId) => deps.stopSession(sessionId)));
      return cancelled;
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows/:id/resume', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id } = workflowParams.parse(request.params);
    const { version } = versionBody.parse(request.body);
    try {
      const actor = await requireAuthority(request, 'workflow:resume', { workflowId: id });
      return await store.resumeBlockedWorkflow(id, version, actor);
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows/:id/decisions', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id } = workflowParams.parse(request.params);
    const body = decisionBody.parse(request.body);
    try {
      const actor = await requireAuthority(request, 'decision:approve', {
        workflowId: id,
        stepId: body.stepId,
      });
      const gate = await store.getGateCandidate(id, body.stepId, body.version);
      if (gate === undefined || gate.completionGate !== 'user.decision')
        throw new WorkflowConflictError('decision step is not ready');
      if (!deps.mergeConfigured) {
        reply.code(503);
        return { error: 'pull request merging is not configured' };
      }
      return await store.completeGate(
        gate,
        { ...(gate.expectedEvidence as object), approved: true },
        actor,
      );
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/internal/workflow/result', async (request, reply): Promise<unknown> => {
    if (deps.store === undefined || deps.capabilities === undefined) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = resultBody.parse(request.body);
    try {
      const presented = bearerToken(request.headers.authorization) ?? '';
      const binding = presented === '' ? undefined : await deps.capabilities.resolve(presented);
      const socketIdentity = internalConnectionIdentity(request);
      if (
        binding === undefined ||
        socketIdentity === undefined ||
        socketIdentity.projectId !== binding.projectId ||
        socketIdentity.containerGeneration !== binding.containerGeneration
      ) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const session = await deps.getSession(body.sessionId);
      if (session === undefined || session.projectId !== binding.projectId) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const pullRequest = body.status === 'completed' ? await deps.sessionPrStatus(session) : null;
      if (
        body.status === 'completed' &&
        (pullRequest === null ||
          pullRequest.phase !== 'open' ||
          pullRequest.headSha === undefined ||
          pullRequest.number !== body.outputs.pullRequest ||
          pullRequest.headSha.toLowerCase() !== String(body.outputs.commit).toLowerCase())
      )
        throw new WorkflowAuthorizationError(
          'result pull request is not the handoff session branch',
        );
      return await deps.store.submitResult(
        {
          capability: body.capability,
          handoffId: body.handoffId,
          projectId: binding.projectId,
          sessionId: body.sessionId,
          pullRequest:
            pullRequest?.number ??
            (Number.isInteger(body.outputs.pullRequest) ? (body.outputs.pullRequest as number) : 0),
          commit:
            pullRequest?.headSha ??
            (typeof body.outputs.commit === 'string' ? body.outputs.commit : ''),
        },
        body,
      );
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });

  app.post('/workflows/:id/image-candidate', async (request, reply): Promise<unknown> => {
    const store = configured(reply);
    if (store === undefined) return { error: 'cross-project workflows are not configured' };
    const { id } = workflowParams.parse(request.params);
    const { digest, version, idempotencyKey } = imageBody.parse(request.body);
    try {
      const actor = await requireAuthority(request, 'artifact:propose', { workflowId: id });
      return await store.recordImageCandidate(id, digest, actor.id, version, idempotencyKey);
    } catch (error) {
      const known = workflowError(error, reply);
      if (known !== undefined) return known;
      throw error;
    }
  });
}
