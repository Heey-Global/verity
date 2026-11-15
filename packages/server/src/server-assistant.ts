import type { AssistantContextProject } from '@verity/events';
import type { ProjectRecord, SequencedEvent } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { registerAssistantConversationRoutes } from './assistant-conversation-routes.js';
import { ASSISTANT_MODEL, assistantConversationDeps } from './assistant-conversation-runtime.js';
import { registerAssistantRoutes } from './assistant-routes.js';
import { assistantProjectsFor, type AssistantToolDeps } from './assistant-tool.js';
import type { ServerContext } from './server-context.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import { ASSISTANT_CONVERSATION_EVENTS, DEFAULT_MODEL } from './server-support.js';
import type { ModelList } from './server-types.js';
import type { SpawnSession } from './session-create-route.js';

type SessionOverview = ReturnType<typeof createServerSessionOverview>;

/** Closures `buildServer` still owns that the assistant depends on. */
export interface AssistantWiring {
  assistantToolDeps: AssistantToolDeps;
  summarizeSession: SessionOverview['summarizeSession'];
  ensureVerityControlProject: () => Promise<ProjectRecord>;
  availableModels: () => Promise<ModelList>;
  sessionCreate: { spawn: SpawnSession };
}

/**
 * The Verity assistant: its Verity Control session, created on demand, and the
 * conversation routes that drive it.
 */
export function installAssistant(
  app: FastifyInstance,
  ctx: ServerContext,
  {
    assistantToolDeps,
    summarizeSession,
    ensureVerityControlProject,
    availableModels,
    sessionCreate,
  }: AssistantWiring,
): void {
  const { deps, conductor } = ctx;
  // One Verity Control session, recreated under a fresh id if it was deleted. Concurrent
  // callers share one attempt, so two requests never spawn the same session id twice.
  let ensuringAssistant: Promise<string> | undefined;
  const ensureAssistantSession = async (): Promise<string> => {
    let id = await deps.eventStore.assistant.session(randomUUID());
    if (await deps.eventStore.getSession(id)) return id;
    // Never respawn under an old id: rows keyed by a deleted session may outlive it.
    id = await deps.eventStore.assistant.replaceSession(id, randomUUID());
    if (await deps.eventStore.getSession(id)) return id;
    const project = await ensureVerityControlProject();
    // Sonnet when offered; otherwise the default Claude model, as before.
    const model = (
      await availableModels().catch(() => ({ models: [] as string[] }))
    ).models.includes(ASSISTANT_MODEL)
      ? ASSISTANT_MODEL
      : DEFAULT_MODEL;
    const result = await sessionCreate.spawn(
      // Claude is the backend that enforces Verity-tools-only turns (docs/assistant.md).
      { projectId: project.id, sessionId: id, name: 'Verity · Assistant', model },
      app.log,
    );
    if (result.statusCode >= 300) throw new Error('Assistant session could not be created');
    return id;
  };
  async function assistantModelAvailable(): Promise<boolean> {
    return (await availableModels()).models.includes(ASSISTANT_MODEL);
  }
  function subscribeAssistant(id: string, listener: (event: SequencedEvent) => void): () => void {
    return deps.bus.subscribe(id, listener);
  }
  function assistantBusy(id: string): boolean {
    return conductor.isBusy(id);
  }
  function assistantProjects(userId: string): Promise<AssistantContextProject[]> {
    return assistantProjectsFor(assistantToolDeps, userId);
  }
  function assistantHandoff(id: string, handoff: () => Promise<boolean>): Promise<unknown> {
    return conductor.runBackendHandoff(id, handoff);
  }
  function closeAssistantBackend(id: string): void {
    conductor.closeSession?.(id);
  }
  function assistantDispatchTurn(
    id: string,
    prompt: string,
    turn: { clientReplyId: string; initiatedBy: { userId: string } },
  ): Promise<unknown> {
    return conductor.dispatchTurn(id, prompt, {}, turn);
  }
  registerAssistantRoutes(app, deps.eventStore, {
    ensureSession: () =>
      (ensuringAssistant ??= ensureAssistantSession().finally(() => {
        ensuringAssistant = undefined;
      })),
    sessionExists: async (id) => (await deps.eventStore.getSession(id)) !== undefined,
    cancel: (id) => conductor.cancelTurn(id),
  });
  registerAssistantConversationRoutes(
    app,
    deps.eventStore,
    assistantConversationDeps({
      store: deps.eventStore,
      subscribe: subscribeAssistant,
      isBusy: assistantBusy,
      summarize: summarizeSession,
      projects: assistantProjects,
      dispatchTurn: assistantDispatchTurn,
      recentEvents: ASSISTANT_CONVERSATION_EVENTS,
      modelMove: {
        available: assistantModelAvailable,
        runBackendHandoff: assistantHandoff,
        closeSession: closeAssistantBackend,
      },
      log: app.log,
    }),
  );
}
