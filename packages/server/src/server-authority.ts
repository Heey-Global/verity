import type { AssistantToolDeps } from './assistant-tool.js';
import type { ServerContext } from './server-context.js';

export interface ServerExecutionAuthority {
  canExecuteAs: (userId: string | null | undefined, projectId: string | null) => Promise<boolean>;
  runningTurnInitiator: (
    sessionId: string,
    turnId: string,
  ) => Promise<{ userId: string } | undefined>;
  assistantToolDeps: AssistantToolDeps;
}

export function createServerAuthority(ctx: ServerContext): ServerExecutionAuthority {
  const { deps } = ctx;
  const canExecuteAs = async (userId: string | null | undefined, projectId: string | null) => {
    if (!userId) return deps.authRegistry?.isEnabled() !== true;
    return (
      projectId !== null &&
      (await deps.eventStore.hasProjectPermission(userId, projectId, 'execute'))
    );
  };
  // The user a running turn executes for: the `initiatedBy` on the prompt that opened it.
  // `undefined` when the turn is not the session's running one or has no initiator.
  const runningTurnInitiator = async (
    sessionId: string,
    turnId: string,
  ): Promise<{ userId: string } | undefined> => {
    const running = (await deps.eventStore.listRunningTurns()).find(
      (t) => t.sessionId === sessionId,
    );
    if (running?.turnId !== turnId) return undefined;
    const prompt = (await deps.eventStore.getEventsAfter(sessionId, running.promptSeq - 1, 1)).find(
      (event) => event.seq === running.promptSeq,
    )?.event;
    return prompt?.t === 'prompt' ? prompt.initiatedBy : undefined;
  };
  // The assistant acts for the user behind its running turn, and only in granted projects.
  // Reading and filing tasks follow the project routes, where administrators count as
  // readers. Handing off starts a turn, so it needs the same execute permission as
  // `canExecuteAs`, which every later tool call of that turn is checked against.
  const assistantToolDeps: AssistantToolDeps = {
    eventStore: deps.eventStore,
    initiator: runningTurnInitiator,
    permitted: async (userId, projectId, permission) => {
      if (userId === undefined) return deps.authRegistry?.isEnabled() !== true;
      if (permission === 'execute') return canExecuteAs(userId, projectId);
      return (
        (await deps.eventStore.isActiveAdministrator(userId)) ||
        (await deps.eventStore.hasProjectPermission(userId, projectId, 'read'))
      );
    },
    administrator: async (userId) =>
      userId === undefined
        ? deps.authRegistry?.isEnabled() !== true
        : deps.eventStore.isActiveAdministrator(userId),
  };
  return { canExecuteAs, runningTurnInitiator, assistantToolDeps };
}
