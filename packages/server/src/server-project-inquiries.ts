import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import { registerProjectInquiryRuntime } from './project-inquiry-runtime.js';

type InquiryRuntime = ReturnType<typeof registerProjectInquiryRuntime>;

export function createServerInquiryTool(ctx: ServerContext, runtime: () => InquiryRuntime) {
  const { deps } = ctx;
  return async (sessionId: string, userId: string | null, input: unknown): Promise<unknown> => {
    const request = input as { operation: string; inquiryId: string; answer: string };
    if (request.operation === 'list') {
      const session = await deps.eventStore.getSession(sessionId);
      return {
        grants: session?.projectId
          ? await deps.eventStore.projectInquiries.grants(session.projectId)
          : [],
        inquiries: await deps.eventStore.projectInquiries.list(sessionId),
      };
    }
    if (request.operation === 'answer')
      return runtime().answer(sessionId, request.inquiryId, request.answer);
    const body = { ...(input as Record<string, unknown>) };
    delete body.operation;
    return runtime().request(sessionId, userId, body);
  };
}

export function installProjectInquiries(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: Pick<Parameters<typeof registerProjectInquiryRuntime>[0], 'authorized' | 'spawn'>,
): InquiryRuntime {
  const { deps, conductor } = ctx;
  const { authorized, spawn } = wiring;
  return registerProjectInquiryRuntime({
    app,
    store: deps.eventStore,
    conductor,
    authorized,
    spawn,
  });
}
