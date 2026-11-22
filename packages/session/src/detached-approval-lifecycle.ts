import type { PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import type { EventStore } from '@verity/store';
import type { EventBus } from './bus.js';
import {
  DetachedPermissions,
  decideDetachedPermission,
  detachedContinuation,
  detachedPermissionEvent,
} from './detached-permissions.js';

type ContinuationDispatch = ReturnType<typeof detachedContinuation>['dispatch'] & {
  validateSession: () => Promise<boolean>;
};
interface LifecycleDeps {
  store: Pick<EventStore, 'appendEvent' | 'reserveBackgroundDispatch'>;
  bus: EventBus | undefined;
  emitEvent(sessionId: string, event: AgentEvent): Promise<void>;
  persistScoped(
    sessionId: string,
    request: PermissionRequest & { brokeredGrantBindingId?: string },
    scope: 'session' | 'project',
    userId: string,
  ): Promise<void>;
  reportError(sessionId: string, error: unknown): void;
  runWhenIdle(sessionId: string, task: () => Promise<void>): Promise<void>;
  dispatch(
    sessionId: string,
    prompt: string,
    dispatch: ContinuationDispatch,
  ): Promise<{ accepted: boolean }>;
}

/** Detached receipt recovery is independent of any live protocol caller. */
export class DetachedApprovalLifecycle extends DetachedPermissions {
  private readonly scheduled = new Set<string>();
  private readonly failed = new Set<string>();
  constructor(private readonly dependencies: () => LifecycleDeps) {
    super();
  }

  async refreshForSession(sessionId: string): Promise<void> {
    const deps = this.dependencies();
    await this.refresh(sessionId, async (request) => {
      const event = detachedPermissionEvent(request);
      const persisted = await deps.store.appendEvent(sessionId, event);
      deps.bus?.publish(sessionId, { seq: persisted.seq, ts: persisted.ts, event });
    });
    await this.tryResumeApproved(sessionId);
  }

  private async tryResumeApproved(sessionId: string): Promise<void> {
    const deps = this.dependencies();
    // A failed continuation must not make the read lose an otherwise actionable card.
    try {
      await this.resumeApproved(sessionId);
    } catch (error) {
      if (!this.failed.has(sessionId)) {
        this.failed.add(sessionId);
        deps.reportError(sessionId, error);
        await deps.emitEvent(sessionId, {
          t: 'notice',
          role: 'agent',
          text: 'Your secret approval is saved, but the workflow could not resume yet. Reopen this session to retry; an expired receipt can be requested again.',
        });
      }
    }
  }

  async resumeWorkflow(
    sessionId: string,
    request: PermissionRequest,
    actorId?: string,
    validate?: () => Promise<boolean>,
  ): Promise<void> {
    const deps = this.dependencies();
    const { prompt, dispatch } = detachedContinuation(request, actorId);
    const id = dispatch.durableDispatchId;
    await deps.store.reserveBackgroundDispatch(id, sessionId);
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    try {
      await deps.runWhenIdle(sessionId, async () => {
        try {
          const result = await deps.dispatch(sessionId, prompt, {
            ...dispatch,
            validateSession: async () => (validate ? validate() : true),
          });
          if (result.accepted) this.failed.delete(sessionId);
        } finally {
          this.scheduled.delete(id);
        }
      });
    } catch (error) {
      this.scheduled.delete(id);
      throw error;
    }
  }

  async refreshAndAnswer(input: Parameters<DetachedApprovalLifecycle['answer']>[0]) {
    await this.refreshForSession(input.sessionId);
    return this.answer(input);
  }

  async answer(
    input: Omit<
      Parameters<typeof decideDetachedPermission>[0],
      'permissions' | 'notice' | 'resume' | 'persistScoped' | 'recordDecision' | 'options'
    > & {
      options?:
        | (Parameters<typeof decideDetachedPermission>[0]['options'] & {
            decidedByUser?: string;
          })
        | undefined;
    },
  ): Promise<boolean | undefined> {
    const actorId = input.options?.decidedByUser ?? input.options?.actorId;
    return decideDetachedPermission({
      ...input,
      permissions: this,
      options: { ...input.options, ...(actorId === undefined ? {} : { actorId }) },
      persistScoped: (request, scope) => {
        if (!actorId || actorId === '__local__')
          throw new Error('a standing grant needs the person granting it');
        return this.dependencies().persistScoped(input.sessionId, request, scope, actorId);
      },
      notice: (text) =>
        this.dependencies().emitEvent(input.sessionId, { t: 'notice', role: 'agent', text }),
      recordDecision: (event) => this.dependencies().emitEvent(input.sessionId, event),
      resume: () => this.tryResumeApproved(input.sessionId),
    });
  }
}
