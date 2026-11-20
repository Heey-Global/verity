import { appendExternalPromptData, type AgentEvent } from '@verity/events';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';

export interface DetachedPermission extends PermissionRequest {
  brokeredGrantBindingId?: string;
  createdAt?: number;
}

export interface DetachedPermissionProvider {
  list(sessionId: string): Promise<DetachedPermission[]>;
  failScoped?(sessionId: string, id: string): Promise<void>;
  markScopedSaved?(sessionId: string, id: string): Promise<void>;
  completeScoped?(sessionId: string, id: string): Promise<void>;
  resumeApproved?(sessionId: string): Promise<void>;
  decide(
    sessionId: string,
    id: string,
    decision: PermissionDecision,
    actorId: string,
    scope: 'once' | 'session' | 'project',
  ): Promise<boolean>;
}

/** Cards outlive the caller. Only an exact later tool invocation can redeem approval. */
export class DetachedPermissions {
  private provider?: DetachedPermissionProvider;
  private readonly requests = new Map<string, Map<string, DetachedPermission>>();
  private readonly surfaced = new Set<string>();

  private readonly operations = new Map<string, Promise<unknown>>();

  private async serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.operations.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.operations.get(sessionId) === next) this.operations.delete(sessionId);
    }
  }

  configure(provider: DetachedPermissionProvider): void {
    this.provider = provider;
  }

  ids(sessionId: string): string[] {
    return [...(this.requests.get(sessionId)?.keys() ?? [])];
  }

  descriptors(sessionId: string) {
    return [...(this.requests.get(sessionId)?.values() ?? [])].map((request) => ({
      toolUseId: request.toolUseId,
      tool: request.toolName,
      riskClass: 'ask' as const,
      grantChannel: 'acp' as const,
      detached: true as const,
      ...(request.createdAt === undefined ? {} : { createdAt: request.createdAt }),
      input: request.input,
    }));
  }

  async refresh(
    sessionId: string,
    publish: (request: DetachedPermission) => Promise<void>,
  ): Promise<void> {
    return this.serialize(sessionId, async () => {
      if (!this.provider) return;
      const pending = await this.provider.list(sessionId);
      const liveIds = new Set(pending.map((request) => request.toolUseId));
      for (const oldId of this.ids(sessionId)) if (!liveIds.has(oldId)) this.surfaced.delete(oldId);
      this.requests.set(sessionId, new Map(pending.map((request) => [request.toolUseId, request])));
      for (const request of pending) {
        if (this.surfaced.has(request.toolUseId)) continue;
        await publish(request);
        this.surfaced.add(request.toolUseId);
      }
    });
  }

  async failScoped(sessionId: string, id: string): Promise<void> {
    await this.provider?.failScoped?.(sessionId, id);
  }

  async completeScoped(sessionId: string, id: string): Promise<void> {
    await this.provider?.completeScoped?.(sessionId, id);
  }

  async markScopedSaved(sessionId: string, id: string): Promise<void> {
    await this.provider?.markScopedSaved?.(sessionId, id);
  }

  async resumeApproved(sessionId: string): Promise<void> {
    await this.provider?.resumeApproved?.(sessionId);
  }

  async decide(
    sessionId: string,
    id: string,
    decision: PermissionDecision,
    actorId: string,
    scope: 'once' | 'session' | 'project',
  ): Promise<DetachedPermission | undefined> {
    return this.serialize(sessionId, async () => {
      const request = this.requests.get(sessionId)?.get(id);
      if (!request || !this.provider) return undefined;
      if (!(await this.provider.decide(sessionId, id, decision, actorId, scope))) return undefined;
      this.requests.get(sessionId)?.delete(id);
      this.surfaced.delete(id);
      return request;
    });
  }
}

export function detachedPermissionEvent(request: PermissionRequest): AgentEvent {
  return {
    t: 'permission',
    id: request.toolUseId,
    tool: request.toolName,
    input: request.input,
    riskClass: 'ask',
    grantChannel: 'acp',
  };
}

export function detachedContinuation(request: PermissionRequest, actorId?: string) {
  return {
    prompt: appendExternalPromptData(
      `Verity approval ${request.toolUseId} was granted for the exact ${request.toolName} request below. Continue the original authorized task if still relevant. Retry that exact tool request once to redeem the approval; do not execute it by another route or repeat an operation whose execution is uncertain. The approved receipt is valid for five minutes. No other action or broader access was approved.`,
      'Approved secret tool request',
      { tool: request.toolName, input: request.input },
    ),
    dispatch: {
      durableDispatchId: `secret-approval:${request.toolUseId}`,
      displayPrompt: `Continue after approval of ${request.toolName} (${request.toolUseId}).`,
      ...(actorId === undefined ? {} : { initiatedBy: { userId: actorId } }),
    },
  };
}

export async function decideDetachedPermission(input: {
  permissions: DetachedPermissions;
  sessionId: string;
  toolUseId: string;
  decision: PermissionDecision;
  options?:
    | {
        scope?: 'once' | 'session' | 'project' | 'forever';
        actorId?: string;
        onScopeSaved?: (saved: boolean) => void;
      }
    | undefined;
  persistScoped: (request: DetachedPermission, scope: 'session' | 'project') => Promise<void>;
  notice: (text: string) => Promise<void>;
  resume: (request: DetachedPermission, actorId?: string) => Promise<void>;
}): Promise<boolean | undefined> {
  const { permissions, sessionId, toolUseId, decision, options } = input;
  if (!permissions.ids(sessionId).includes(toolUseId)) return undefined;
  if (
    (decision.behavior === 'allow' && decision.updatedInput !== undefined) ||
    options?.scope === 'forever'
  )
    return false;
  const request = await permissions.decide(
    sessionId,
    toolUseId,
    decision,
    options?.actorId ?? '__local__',
    options?.scope ?? 'once',
  );
  if (!request) return false;
  let continuationAllowed = true;
  let reusableScopeSaved = false;
  if (decision.behavior === 'allow' && options?.scope && options.scope !== 'once') {
    try {
      // Retire exact once consent before saving reusable scope, so later grant
      // revocation cannot uncover a latent receipt for the same operation.
      await permissions.completeScoped(sessionId, toolUseId);
      await input.persistScoped(request, options.scope);
      reusableScopeSaved = true;
      options.onScopeSaved?.(true);
    } catch {
      await permissions.failScoped(sessionId, toolUseId);
      continuationAllowed = false;
      options.onScopeSaved?.(false);
    }
  }
  if (reusableScopeSaved) {
    try {
      await permissions.markScopedSaved(sessionId, toolUseId);
    } catch {
      continuationAllowed = false;
    }
  }
  const text = !continuationAllowed
    ? reusableScopeSaved
      ? 'The reusable secret approval was saved and remains active, but automatic continuation could not be recorded. Answering the card did not execute the action. If still needed, retry only the exact original authorized request once.'
      : 'The requested reusable secret approval could not be saved. Nothing ran and this approval will not resume the action. Review and request the operation again if it is still needed.'
    : `Secret tool approval ${toolUseId} was ${decision.behavior === 'allow' ? 'approved' : 'denied'}. Nothing was executed by answering the card. ${
        decision.behavior === 'allow'
          ? reusableScopeSaved
            ? `The selected ${options?.scope} approval was saved; continue only the original authorized action.`
            : 'If the operation is still needed, retry the exact original tool request; its approval is single-use and valid for five minutes.'
          : 'Do not retry this operation without a new user instruction.'
      }`;
  await input.notice(text);
  if (decision.behavior === 'allow' && continuationAllowed)
    await input.resume(request, options?.actorId === '__local__' ? undefined : options?.actorId);
  return true;
}
