import type { Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';

import type { BrokeredToolApprovalStore } from './brokered-tool-approval-store.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import {
  brokeredDopplerBindingId,
  parseBrokeredDopplerBinding,
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
  const requestFor = (
    record: Awaited<ReturnType<BrokeredToolApprovalStore['listPending']>>[number],
  ) => ({
    requestId: record.id,
    toolUseId: record.id,
    toolName: record.toolName,
    createdAt: Date.parse(record.createdAt),
    input: JSON.parse(record.canonicalInput) as Record<string, unknown>,
    brokeredGrantBindingId: brokeredDopplerBindingId(
      parseBrokeredDopplerBinding(record.authorizationSnapshot),
    ),
  });
  conductor.configureDetachedPermissions({
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
        if (!record.decidedBy || !(await input.canExecute(record.decidedBy, record.projectId)))
          continue;
        await conductor.resumeDetachedPermission(
          sessionId,
          requestFor(record),
          input.localActor && record.decidedBy === '__local__' ? undefined : record.decidedBy,
          async () => {
            const active = (await approvals.listApproved(sessionId)).some(
              (entry) => entry.id === record.id,
            );
            const session = await store.getSession(sessionId);
            if (
              !active ||
              !session ||
              (session.projectId !== null && session.projectId !== record.projectId) ||
              !(await input.canExecute(record.decidedBy!, record.projectId))
            )
              return false;
            const snapshot = await gateway.authorizationSnapshot?.({
              projectId: record.projectId,
              sessionId,
              turnId: '',
              toolName: record.toolName,
              request: JSON.parse(record.canonicalInput) as Record<string, unknown>,
            });
            return snapshot === record.authorizationSnapshot;
          },
        );
      }
    },
    list: async (sessionId) => {
      if (!(await store.getSession(sessionId))) return [];
      return (await approvals.listPending(sessionId)).map(requestFor);
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
      if (decision.behavior === 'allow') {
        const current = await gateway.authorizationSnapshot?.({
          projectId: record.projectId,
          sessionId,
          turnId: '',
          toolName: record.toolName,
          request: JSON.parse(record.canonicalInput) as Record<string, unknown>,
        });
        if (current !== record.authorizationSnapshot) return false;
      }
      return (
        (await approvals.decide(id, sessionId, decision.behavior === 'allow', actorId, scope)) !==
        undefined
      );
    },
  });
}
