import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import { registerProjectInquiryRuntime } from './project-inquiry-runtime.js';
import { installSessionCollaboration } from './session-collaboration-routes.js';

import { inquiryForwardingRefusal } from './project-inquiries.js';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';

export async function authorizeInquiryTargetTool(
  store: ServerContext['deps']['eventStore'],
  sessionId: string,
  toolName: string,
  request: unknown,
): Promise<void> {
  if (toolName === 'verity_app_help') return;
  if (toolName === 'verity_project_inquiry') {
    const { operation } = request as { operation: string };
    if (operation === 'answer' || operation === 'list') return;
    if (await store.projectInquiries.isTarget(sessionId))
      throw new ControlPlaneSessionAuthorityError(inquiryForwardingRefusal);
  }
  if (
    (await store.getSession(sessionId))?.planning === 'active' &&
    (await store.projectInquiries.isReadOnlyTarget(sessionId))
  )
    throw new ControlPlaneSessionAuthorityError(
      'Inquiry investigation is read-only; changes require target-side human approval',
    );
}

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
  // The header's collaboration row reads inquiries alongside coordination requests.
  installSessionCollaboration(app, ctx, { authorized });
  return registerProjectInquiryRuntime({
    app,
    store: deps.eventStore,
    conductor,
    authorized,
    spawn,
  });
}
