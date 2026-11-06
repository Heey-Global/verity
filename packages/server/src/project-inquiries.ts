import { createHash } from 'node:crypto';
import { isSessionLinkProject, type EventStore, type ProjectInquiry } from '@verity/store';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';

const requestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    targetProjectId: z.string().min(1).max(128),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(12000),
    kind: z.enum(['question', 'change']),
  })
  .strict();

export interface ProjectInquiryDeps {
  store: EventStore;
  authorized: (userId: string | null, projectId: string) => Promise<boolean>;
  createSession: (projectId: string, sessionId: string, name: string) => Promise<void>;
  reply?: (inquiry: ProjectInquiry, validate: () => Promise<boolean>) => Promise<boolean>;
  busy: (sessionId: string) => boolean;
  dispatch: (inquiry: ProjectInquiry, validate: () => Promise<boolean>) => Promise<boolean>;
}

/** Messages are data; only a separate target-side human decision admits changes. */
export function createProjectInquiries(deps: ProjectInquiryDeps) {
  const store = deps.store;
  let requestCursor: string | undefined;
  let answerCursor: string | undefined;
  const locks = new Map<string, Promise<unknown>>();
  async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    locks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(key) === operation) locks.delete(key);
    }
  }
  async function allowed(inquiry: ProjectInquiry): Promise<boolean> {
    const [source, target] = await Promise.all([
      store.getProject(inquiry.sourceProjectId),
      store.getProject(inquiry.targetProjectId),
    ]);
    return (
      !!source &&
      !!target &&
      isSessionLinkProject(source) &&
      isSessionLinkProject(target) &&
      source.kind !== 'control_plane' &&
      target.kind !== 'control_plane' &&
      (await store.projectInquiries.allowed(source.id, target.id)) &&
      (await deps.authorized(inquiry.userId, source.id)) &&
      (await deps.authorized(inquiry.userId, target.id))
    );
  }
  async function deliver(inquiry: ProjectInquiry): Promise<void> {
    await serialized(`deliver:${inquiry.targetSessionId}`, async () => {
      const current = await store.projectInquiries.get(inquiry.id);
      if (current?.status !== 'approved' || deps.busy(current.targetSessionId)) return;
      const target = await store.getSession(current.targetSessionId);
      if (target?.projectId !== current.targetProjectId || !(await allowed(current))) {
        await store.projectInquiries.block(current.id);
        return;
      }
      // The conductor invokes validation under its admission lock, so a question
      // cannot change the posture of a write turn that became busy concurrently.
      const accepted = await deps.dispatch(current, async () => {
        if (!(await allowed(current))) return false;
        await store.setSessionPlanning(
          current.targetSessionId,
          current.kind === 'question' ? 'active' : 'implemented',
        );
        return true;
      });
      if (accepted) await store.projectInquiries.markQueued(current.id);
    });
  }
  return {
    async request(
      sourceSessionId: string,
      userId: string | null,
      input: unknown,
    ): Promise<ProjectInquiry> {
      const request = requestSchema.parse(input);
      const source = await store.getSession(sourceSessionId);
      if (!source?.projectId || (await store.projectInquiries.isTarget(sourceSessionId)))
        throw new Error('Inquiry targets cannot forward requests');
      const sourceProjectId = source.projectId;
      if (sourceProjectId === request.targetProjectId) throw new Error('Choose another project');
      const targetSessionId = createHash('sha256')
        .update(`inquiry:${sourceSessionId}:${request.targetProjectId}`)
        .digest('hex');
      const id = createHash('sha256')
        .update(`${sourceSessionId}:${request.requestId}`)
        .digest('hex');
      const candidate = {
        id,
        sourceSessionId,
        targetSessionId,
        sourceProjectId,
        targetProjectId: request.targetProjectId,
        title: request.title,
        body: request.body,
        kind: request.kind,
        status: request.kind === 'change' ? ('pending' as const) : ('approved' as const),
        userId,
        answer: null,
        decidedBy: null,
        createdAt: new Date().toISOString(),
      };
      if (!(await allowed(candidate)))
        throw new Error('Target project is unavailable or not permitted');
      return serialized(`create:${sourceSessionId}:${request.targetProjectId}`, async () => {
        const existing = await store.getSession(targetSessionId);
        if (!existing)
          await deps.createSession(
            request.targetProjectId,
            targetSessionId,
            `Inquiry · ${request.title}`,
          );
        await store.projectInquiries.bind(
          sourceSessionId,
          request.targetProjectId,
          targetSessionId,
        );
        await store.createSessionLink(sourceSessionId, targetSessionId);
        const inquiry = await store.projectInquiries.create(candidate);
        await deliver(inquiry);
        return (await store.projectInquiries.get(inquiry.id))!;
      });
    },
    async decide(targetSessionId: string, id: string, userId: string | null, approve: boolean) {
      const inquiry = await store.projectInquiries.get(id);
      if (
        !inquiry ||
        inquiry.targetSessionId !== targetSessionId ||
        !(await deps.authorized(userId, inquiry.targetProjectId))
      )
        throw new Error('Request unavailable');
      if (!(await store.projectInquiries.decide(id, targetSessionId, approve, userId)))
        throw new Error('Request already decided or revoked');
      if (approve) await deliver((await store.projectInquiries.get(id))!);
      return store.projectInquiries.get(id);
    },
    async answer(targetSessionId: string, id: string, answer: string) {
      const text = z.string().trim().min(1).max(20000).parse(answer);
      if (!(await store.projectInquiries.answer(id, targetSessionId, text)))
        throw new Error('Request unavailable');
      const inquiry = await store.projectInquiries.get(id);
      if (
        inquiry &&
        deps.reply &&
        (await allowed(inquiry)) &&
        (await deps.reply(inquiry, () => allowed(inquiry)))
      )
        await store.projectInquiries.markAnswerDelivered(id);
      return inquiry;
    },
    async recover() {
      const requests = await store.projectInquiries.undelivered(requestCursor);
      requestCursor = requests.length === 100 ? requests.at(-1)?.id : undefined;
      for (const inquiry of requests) {
        try {
          await deliver(inquiry);
        } catch {
          /* Keep durable requests retryable; one unavailable target must not starve others. */
        }
      }
      if (deps.reply) {
        const answers = await store.projectInquiries.unansweredDeliveries(answerCursor);
        answerCursor = answers.length === 100 ? answers.at(-1)?.id : undefined;
        for (const inquiry of answers) {
          try {
            if ((await allowed(inquiry)) && (await deps.reply(inquiry, () => allowed(inquiry))))
              await store.projectInquiries.markAnswerDelivered(inquiry.id);
          } catch {
            // Retry a failed notification without starving answers for other source sessions.
          }
        }
      }
    },
  };
}

export function registerProjectInquiryRoutes(
  app: FastifyInstance,
  deps: ProjectInquiryDeps,
  service: ReturnType<typeof createProjectInquiries>,
  userId: (request: unknown) => string | null,
): void {
  const params = z.object({ id: z.string().min(1) });
  const named = async (inquiries: ProjectInquiry[]) => {
    const projects = await deps.store.listProjects();
    return inquiries.map((inquiry) => ({
      ...inquiry,
      sourceProjectName:
        projects.find((p) => p.id === inquiry.sourceProjectId)?.repo ?? inquiry.sourceProjectId,
      targetProjectName:
        projects.find((p) => p.id === inquiry.targetProjectId)?.repo ?? inquiry.targetProjectId,
    }));
  };
  app.get('/projects/:id/inquiry-grants', async (request) => ({
    grants: await deps.store.projectInquiries.grants(params.parse(request.params).id),
  }));
  app.put('/projects/:id/inquiry-grants', async (request, reply) => {
    const { id } = params.parse(request.params);
    const body = z
      .object({ targetProjectId: z.string().min(1), enabled: z.boolean() })
      .strict()
      .parse(request.body);
    if (!(await deps.authorized(userId(request), body.targetProjectId)))
      return reply.code(403).send({ error: 'Target project unavailable' });
    await deps.store.projectInquiries.setGrant(id, body.targetProjectId, body.enabled);
    return { grants: await deps.store.projectInquiries.grants(id) };
  });
  app.get('/sessions/:id/project-inquiries', async (request) => ({
    inquiries: await named(await deps.store.projectInquiries.list(params.parse(request.params).id)),
  }));
  app.get('/project-inquiries/pending', async (request) => {
    const inquiries = [];
    for (const inquiry of await deps.store.projectInquiries.list(undefined, true)) {
      if (await deps.authorized(userId(request), inquiry.targetProjectId)) inquiries.push(inquiry);
    }
    return { inquiries: await named(inquiries) };
  });
  app.post('/sessions/:id/project-inquiries', async (request, reply) => {
    try {
      return {
        inquiry: await service.request(
          params.parse(request.params).id,
          userId(request),
          request.body,
        ),
      };
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : 'Request failed' });
    }
  });
  app.post('/sessions/:id/project-inquiries/:inquiryId/decision', async (request, reply) => {
    const { id, inquiryId } = params.extend({ inquiryId: z.string().min(1) }).parse(request.params);
    const { decision } = z
      .object({ decision: z.enum(['approve', 'reject']) })
      .strict()
      .parse(request.body);
    try {
      return {
        inquiry: await service.decide(id, inquiryId, userId(request), decision === 'approve'),
      };
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : 'Decision failed' });
    }
  });
}
