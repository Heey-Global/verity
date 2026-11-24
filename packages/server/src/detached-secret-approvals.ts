import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from './server-deps.js';
import { registerSecretApprovalRoutes } from './secret-approval-routes.js';
import { legacyAdministratorId } from './view-state-routes.js';
import { secretApprovalNotice, type Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';

import type {
  BrokeredToolApprovalRecord,
  BrokeredToolApprovalStore,
} from './brokered-tool-approval-store.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import {
  brokeredDopplerBindingId,
  brokeredSecretSource,
  tryParseBrokeredDopplerBinding,
} from './brokered-doppler-binding.js';

/** Restoring a card never restores a caller or executes a tool. Approval is a receipt
 * for an exact future invocation, checked again by the gateway at consumption. */
export function configureDetachedSecretApprovals(input: {
  conductor: Conductor;
  store: Pick<EventStore, 'getSession'>;
  approvals: BrokeredToolApprovalStore;
  gateway: Pick<McpGatewayDeps, 'authorizationSnapshot'>;
  localActor?: boolean;
  canExecute: (userId: string, projectId: string) => Promise<boolean>;
}): void {
  const { conductor, store, approvals, gateway } = input;
  const requestFor = (record: BrokeredToolApprovalRecord, historic = false) => {
    const binding = tryParseBrokeredDopplerBinding(record.authorizationSnapshot);
    if (!binding && !historic) return undefined;
    try {
      return {
        requestId: record.id,
        toolUseId: record.id,
        toolName: record.toolName,
        createdAt: Date.parse(record.createdAt),
        input: JSON.parse(record.canonicalInput) as Record<string, unknown>,
        ...(binding && {
          secretSource: brokeredSecretSource(binding),
          brokeredGrantBindingId: brokeredDopplerBindingId(binding),
        }),
      };
    } catch {
      return undefined;
    }
  };
  const matchesCurrentSnapshot = async (
    record: BrokeredToolApprovalRecord,
    request: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const current = await gateway.authorizationSnapshot?.({
        projectId: record.projectId,
        sessionId: record.sessionId,
        turnId: '',
        toolName: record.toolName,
        request,
      });
      return current === record.authorizationSnapshot;
    } catch {
      return false;
    }
  };
  const actorFor = (actorId: string) =>
    input.localActor && actorId === '__local__' ? legacyAdministratorId : actorId;
  conductor.configureDetachedPermissions({
    listUnrecordedDecisions: async (sessionId) =>
      (await approvals.listUnrecordedDecisions(sessionId)).flatMap((record) => {
        const request = requestFor(record, true);
        if (!request) return [];
        const outcome =
          record.status === 'denied'
            ? record.scope === null
              ? 'denied'
              : 'save_failed'
            : (record.scope ?? 'denied');
        return [secretApprovalNotice(request, outcome)];
      }),
    markScopedSaved: async (sessionId, id) => {
      await approvals.markScopedSaved(id, sessionId);
    },
    failScoped: async (sessionId, id) => {
      await approvals.failScoped(id, sessionId);
    },
    completeScoped: async (sessionId, id) => {
      const record = await approvals.get(id, sessionId);
      if (!record) throw new Error('The approved request no longer exists.');
      await approvals.consume(id, record);
    },
    resumeApproved: async (sessionId) => {
      for (const record of await approvals.listApproved(sessionId)) {
        const request = requestFor(record);
        if (
          !request ||
          !record.decidedBy ||
          !(await input.canExecute(actorFor(record.decidedBy), record.projectId))
        )
          continue;
        await conductor.resumeDetachedPermission(
          sessionId,
          request,
          actorFor(record.decidedBy),
          async () => {
            const active = (await approvals.listApproved(sessionId)).some(
              (entry) => entry.id === record.id,
            );
            const session = await store.getSession(sessionId);
            if (
              !active ||
              !session ||
              (session.projectId !== null && session.projectId !== record.projectId) ||
              !(await input.canExecute(actorFor(record.decidedBy!), record.projectId))
            )
              return false;
            return matchesCurrentSnapshot(record, request.input);
          },
        );
      }
    },
    list: async (sessionId) => {
      if (!(await store.getSession(sessionId))) return [];
      return (await approvals.listPending(sessionId)).flatMap((record) => {
        const request = requestFor(record);
        return request ? [request] : [];
      });
    },
    decide: async (sessionId, id, decision, actorId, scope) => {
      const record = await approvals.get(id, sessionId);
      if (!record || record.status !== 'pending') return false;
      const session = await store.getSession(sessionId);
      if (
        !session ||
        (session.projectId !== null && session.projectId !== record.projectId) ||
        !(await input.canExecute(actorId, record.projectId))
      )
        return false;
      const request = requestFor(record);
      if (
        !request ||
        (decision.behavior === 'allow' && !(await matchesCurrentSnapshot(record, request.input)))
      )
        return false;
      return (
        (await approvals.decide(id, sessionId, decision.behavior === 'allow', actorId, scope)) !==
        undefined
      );
    },
  });
}

/** Install consent recovery and its history before admitting gateway calls. */
export function installDetachedSecretApprovals(
  app: FastifyInstance,
  deps: Pick<ServerDeps, 'eventStore' | 'mcpGateway' | 'authRegistry'>,
  conductor: Conductor,
  canExecuteAs: (userId: string | null | undefined, projectId: string | null) => Promise<boolean>,
) {
  const gateway = deps.mcpGateway;
  if (!gateway) throw new Error('Secret approval wiring requires an MCP gateway.');
  if (gateway.detachedApprovals) {
    configureDetachedSecretApprovals({
      conductor,
      store: deps.eventStore,
      approvals: gateway.detachedApprovals,
      gateway,
      canExecute: (userId, projectId) =>
        canExecuteAs(
          userId === '__local__' && deps.authRegistry?.isEnabled() !== true ? undefined : userId,
          projectId,
        ),
      localActor: deps.authRegistry?.isEnabled() !== true,
    });
    registerSecretApprovalRoutes(app, {
      approvals: gateway.detachedApprovals,
      store: deps.eventStore,
      permitted: canExecuteAs,
      refresh: (id) => conductor.refreshDetachedPermissions(id),
    });
  }
  return {
    ...gateway,
    authorizeDetachedApproval: async (input: {
      projectId: string;
      sessionId: string;
      turnId: string;
      decidedBy: string | null;
    }) => {
      const initiator = await deps.eventStore.runningTurnInitiator(input.sessionId, input.turnId);
      const local = deps.authRegistry?.isEnabled() !== true;
      const callerId = initiator?.userId ?? (local ? legacyAdministratorId : undefined);
      const approverId =
        local && input.decidedBy === '__local__' ? legacyAdministratorId : input.decidedBy;
      if (!callerId || callerId !== approverId)
        throw new Error('The secret approval belongs to a different user. Nothing ran.');
      await gateway.authorizeDetachedApproval?.(input);
    },
    surfaceDetachedApproval: (sessionId: string) => conductor.refreshDetachedPermissions(sessionId),
  };
}
