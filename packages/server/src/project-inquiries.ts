import { createHash } from 'node:crypto';
import { isSessionLinkProject, type EventStore, type ProjectInquiry } from '@verity/store';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
} from './session-handoff-tool.js';

export const inquiryForwardingRefusal =
  'Inquiry targets cannot forward requests. Ask the originating session to send the follow-up.';

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
  /** Both projects exist, can be linked, and the requesting user may act in both. */
  async function permitted(inquiry: ProjectInquiry): Promise<boolean> {
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
      (await deps.authorized(inquiry.userId, source.id)) &&
      (await deps.authorized(inquiry.userId, target.id))
    );
  }
  /**
   * Delivery also needs consent: a person allowed this request on its card, or a
   * standing grant admits it. The grant is read on every check, so revoking it
   * stops questions it admitted even after they were queued for recovery.
   */
  async function allowed(inquiry: ProjectInquiry): Promise<boolean> {
    return (
      (await permitted(inquiry)) &&
      (inquiry.humanApproved ||
        (inquiry.kind === 'question' &&
          (await store.projectInquiries.allowed(inquiry.sourceProjectId, inquiry.targetProjectId))))
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
        if (
          (await store.repairs.dispatchReceipt(`project-inquiry:${current.id}`))?.state ===
          'admitted'
        )
          return true;
        await store.projectInquiries.activate(current.id);
        await store.setSessionPlanning(
          current.targetSessionId,
          current.kind === 'question' ? 'active' : 'implemented',
        );
        return true;
      });
      if (accepted) await store.projectInquiries.markQueued(current.id);
    });
  }
  async function provision(inquiry: ProjectInquiry): Promise<void> {
    if (inquiry.status !== 'provisioning') return;
    if (!(await allowed(inquiry))) {
      await store.projectInquiries.block(inquiry.id);
      return;
    }
    const existing = await store.getSession(inquiry.targetSessionId);
    if (!existing)
      await deps.createSession(
        inquiry.targetProjectId,
        inquiry.targetSessionId,
        `Inquiry · ${inquiry.title}`,
      );
    await store.projectInquiries.bind(
      inquiry.sourceSessionId,
      inquiry.targetProjectId,
      inquiry.targetSessionId,
    );
    await store.createSessionLink(inquiry.sourceSessionId, inquiry.targetSessionId);
    await store.projectInquiries.completeProvisioning(inquiry.id);
  }
  return {
    async request(
      sourceSessionId: string,
      userId: string | null,
      input: unknown,
    ): Promise<ProjectInquiry> {
      const request = requestSchema.parse(input);
      const source = await store.getSession(sourceSessionId);
      if (!source?.projectId)
        throw new ControlPlaneSessionAuthorityError('The calling session has no project');
      if (await store.projectInquiries.isTarget(sourceSessionId))
        throw new ControlPlaneSessionAuthorityError(inquiryForwardingRefusal);
      const sourceProjectId = source.projectId;
      if (sourceProjectId === request.targetProjectId)
        throw new ControlPlaneSessionToolError('Choose another project');
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
        status: 'provisioning' as const,
        userId,
        answer: null,
        decidedBy: null,
        humanApproved: false,
        createdAt: new Date().toISOString(),
      };
      if (!(await permitted(candidate)))
        throw new ControlPlaneSessionToolError('Target project is unavailable or not permitted');
      return serialized(`create:${sourceSessionId}:${request.targetProjectId}`, async () => {
        // The store keeps the request pending unless a standing grant admits it;
        // a pending request neither creates the target session nor reaches it.
        const inquiry = await store.projectInquiries.create(candidate);
        await provision(inquiry);
        await deliver(inquiry);
        return (await store.projectInquiries.get(inquiry.id))!;
      });
    },
    async decide(
      targetProjectId: string,
      id: string,
      userId: string | null,
      decision: 'approve' | 'approve_always' | 'reject',
    ) {
      const inquiry = await store.projectInquiries.get(id);
      const always = decision === 'approve_always';
      // A standing grant speaks for the source project too, so it needs both.
      if (
        !inquiry ||
        inquiry.targetProjectId !== targetProjectId ||
        !(await deps.authorized(userId, inquiry.targetProjectId)) ||
        (always && !(await deps.authorized(userId, inquiry.sourceProjectId)))
      )
        throw new Error('Request unavailable');
      if (always && inquiry.kind !== 'question')
        throw new Error('Only questions can be always allowed');
      const approve = decision !== 'reject';
      const decided = await store.projectInquiries.decide(
        id,
        inquiry.targetSessionId,
        approve,
        userId,
        always,
      );
      if (!decided) throw new Error('Request already decided or revoked');
      if (approve)
        await serialized(
          `create:${inquiry.sourceSessionId}:${inquiry.targetProjectId}`,
          async () => {
            const current = (await store.projectInquiries.get(id))!;
            await provision(current);
            await deliver((await store.projectInquiries.get(id))!);
          },
        );
      return store.projectInquiries.get(id);
    },
    async answer(targetSessionId: string, id: string, answer: string) {
      const text = z.string().trim().min(1).max(20000).parse(answer);
      if (!(await store.projectInquiries.answer(id, targetSessionId, text)))
        throw new ControlPlaneSessionToolError('Request unavailable');
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
          await serialized(
            `create:${inquiry.sourceSessionId}:${inquiry.targetProjectId}`,
            async () => {
              await provision(inquiry);
              await deliver(inquiry);
            },
          );
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
    const sessionNames = new Map<string, string | null>();
    for (const id of new Set(inquiries.map((inquiry) => inquiry.sourceSessionId)))
      sessionNames.set(id, (await deps.store.getSession(id))?.name ?? null);
    return inquiries.map((inquiry) => ({
      ...inquiry,
      sourceSessionName: sessionNames.get(inquiry.sourceSessionId) ?? null,
      sourceProjectName:
        projects.find((p) => p.id === inquiry.sourceProjectId)?.name ?? inquiry.sourceProjectId,
      targetProjectName:
        projects.find((p) => p.id === inquiry.targetProjectId)?.name ?? inquiry.targetProjectId,
    }));
  };
  app.get('/projects/:id/inquiry-grants', async (request) => ({
    grants: await deps.store.projectInquiries.grants(params.parse(request.params).id),
  }));
  app.put('/projects/:id/inquiry-grants', async (request, reply) => {
    const { id } = params.parse(request.params);
    // Grants are created only by "Always allow" on a request's card; this route revokes.
    const parsed = z
      .object({ targetProjectId: z.string().min(1), enabled: z.literal(false) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Allow a project from a request instead' });
    const body = parsed.data;
    await deps.store.projectInquiries.setGrant(id, body.targetProjectId, false);
    return { grants: await deps.store.projectInquiries.grants(id) };
  });
  app.get('/sessions/:id/project-inquiries', async (request) => ({
    inquiries: await named(await deps.store.projectInquiries.list(params.parse(request.params).id)),
  }));
  app.get('/project-inquiries/pending', async (request) => {
    const { projectId } = z
      .object({ projectId: z.string().min(1).optional() })
      .parse(request.query);
    const targets = [];
    for (const project of await deps.store.listProjects()) {
      if (projectId !== undefined && project.id !== projectId) continue;
      if (await deps.authorized(userId(request), project.id)) targets.push(project.id);
    }
    // Apply access filtering before the bounded query so another user's requests
    // cannot crowd all of this user's actionable approvals out of the overview.
    return {
      inquiries: await named(await deps.store.projectInquiries.list(undefined, true, targets)),
    };
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
  // Scoped to the target project: a pending request has no target session yet.
  app.post('/projects/:id/project-inquiries/:inquiryId/decision', async (request, reply) => {
    const { id, inquiryId } = params.extend({ inquiryId: z.string().min(1) }).parse(request.params);
    const { decision } = z
      .object({ decision: z.enum(['approve', 'approve_always', 'reject']) })
      .strict()
      .parse(request.body);
    try {
      return {
        inquiry: await service.decide(id, inquiryId, userId(request), decision),
      };
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : 'Decision failed' });
    }
  });
}
