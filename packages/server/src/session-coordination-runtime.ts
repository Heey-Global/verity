import {
  CONTROL_PLANE_PROJECT_ID,
  CONTROL_PLANE_PROJECT_OWNER,
  CONTROL_PLANE_PROJECT_REPO,
} from './control-plane-project.js';
import type { EventStore } from '@verity/store';
import type { Conductor } from '@verity/session';
import type { FastifyInstance } from 'fastify';
import type { SpawnSession } from './session-create-route.js';
import { createSessionCoordination } from './session-coordination.js';
import { createLinkedSessionDelivery } from './session-linked-delivery.js';
import { currentPublishedProgress, redactSessionObservationText } from './session-observation.js';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';

type Caller = { projectId: string; sessionId: string; turnId: string; request: unknown };

/** Identity comes from the live gateway turn, never tool arguments or peer text. */
export function createGatewaySessionCoordination(deps: {
  store: EventStore;
  conductor: Conductor;
  app: FastifyInstance;
  spawn: () => SpawnSession;
  authorized(userId: string | null | undefined, projectId: string | null): Promise<boolean>;
  initiator(sessionId: string, turnId: string): Promise<{ userId: string } | undefined>;
}) {
  const { store, conductor } = deps;
  const { deliverLinkedMessage } = createLinkedSessionDelivery(store, conductor);
  const execute = createSessionCoordination({
    store,
    authorized: (userId, projectId) => deps.authorized(userId, projectId),
    requests: store.sessionCoordination,
    spawn: async (projectId, sessionId, name, userId) => {
      const target =
        projectId === CONTROL_PLANE_PROJECT_ID
          ? { project: `${CONTROL_PLANE_PROJECT_OWNER}/${CONTROL_PLANE_PROJECT_REPO}` }
          : { projectId };
      const spawned = await deps.spawn()(
        { ...target, sessionId, name },
        deps.app.log,
        userId ?? undefined,
      );
      if (
        spawned.statusCode >= 300 ||
        !('sessionId' in spawned.result) ||
        spawned.result.sessionId !== sessionId
      )
        throw new Error('Target session creation is incomplete; retry with the same requestId');
    },
    deliver: async (input) => {
      if (
        !input.approvedByCard &&
        !(await store.sessionLinkHasDelivery(
          input.sourceSessionId,
          input.targetSessionId,
          input.invocationId,
        )) &&
        !(await store.sessionLinkHasAllowance(input.sourceSessionId, input.targetSessionId))
      )
        return { status: 'approval_required', targetSessionId: input.targetSessionId };
      const delivered = await deliverLinkedMessage({
        ...input,
        initiatedBy: input.userId ? { userId: input.userId } : undefined,
        approvedByCard: input.approvedByCard === true,
      });
      return { ...delivered, status: delivered.queued ? 'queued' : 'accepted' };
    },
    status: (id) => (conductor.isBusy(id) ? 'busy' : 'idle'),
    readProgress: async (id) => {
      const { events, hasMore } = await store.getEventsBeforeSeq(id, 100);
      const published = currentPublishedProgress(events);
      if (!published) return { stale: true };
      return {
        summary: redactSessionObservationText(published.event.summary),
        updatedAt: new Date(published.ts).toISOString(),
        stale: hasMore || Date.now() - published.ts > 24 * 60 * 60 * 1000,
      };
    },
  });
  async function authorize(input: Caller) {
    const session = await store.getSession(input.sessionId);
    const user = await deps.initiator(input.sessionId, input.turnId);
    if (
      session?.projectId !== input.projectId ||
      !(await deps.authorized(user?.userId, input.projectId))
    )
      throw new ControlPlaneSessionAuthorityError(
        'Session coordination is unavailable or not permitted',
      );
    const targetProjectId = (input.request as { targetProjectId?: string }).targetProjectId;
    if (targetProjectId && !(await deps.authorized(user?.userId, targetProjectId)))
      throw new ControlPlaneSessionAuthorityError('Target project is unavailable or not permitted');
    if (session.planning === 'active' || conductor.isPlanningTurn?.(input.sessionId))
      throw new ControlPlaneSessionAuthorityError(
        'Session coordination is unavailable in planning mode',
      );
    if (await store.projectInquiries.isTarget(input.sessionId))
      throw new ControlPlaneSessionAuthorityError(
        'Inquiry targets cannot coordinate further sessions',
      );
    const running = (await store.listRunningTurns()).find(
      (turn) => turn.sessionId === input.sessionId,
    );
    if (running?.turnId !== input.turnId)
      throw new ControlPlaneSessionAuthorityError('Session coordination requires a live user turn');
    const { events } = await store.getEventsBeforeSeq(input.sessionId, 1, running.promptSeq + 1);
    const prompt = events[0];
    if (prompt?.seq !== running.promptSeq || prompt.event.t !== 'prompt' || prompt.event.peer)
      throw new ControlPlaneSessionAuthorityError(
        'Peer messages cannot authorize session coordination',
      );
    return user;
  }
  return {
    authorize,
    async presentation(input: Caller) {
      await authorize(input);
      const request = input.request as { targetProjectId?: string; targetSessionId?: string };
      const project = request.targetProjectId
        ? await store.getProject(request.targetProjectId)
        : undefined;
      const session = request.targetSessionId
        ? await store.getSession(request.targetSessionId)
        : undefined;
      if (!project || (request.targetSessionId && session?.projectId !== project.id))
        throw new ControlPlaneSessionAuthorityError('Selected coordination target is unavailable');
      return {
        targetProject: { id: project.id, name: project.name || project.repo, kind: project.kind },
        ...(session ? { targetSession: { id: session.sessionId, name: session.name } } : {}),
        scope:
          'Only the selected session creation or link and the exact assignment shown. The link permits bounded bidirectional text exchange. Delivery may renew an exhausted message allowance. No additional project, repository, secret, transcript, or execution permissions.',
      };
    },
    async execute(input: Caller & { approvedByCard?: boolean }) {
      const user = await authorize(input);
      if (
        (input.request as { operation?: string }).operation !== 'discover' &&
        !input.approvedByCard
      )
        throw new ControlPlaneSessionAuthorityError(
          'Session creation and linking require approval of the exact target and assignment',
        );
      return execute({
        sourceSessionId: input.sessionId,
        userId: user?.userId ?? null,
        request: input.request,
        approvedByCard: input.approvedByCard === true,
        validateCaller: async () => {
          await authorize(input);
        },
      });
    },
  };
}
