import { CODEX_DEFAULT_MODEL, isCodexModel } from '@verity/session';
import type { ServerContext } from './server-context.js';
import type { ModelList } from './server-types.js';
import { modelAccounts } from './server-people.js';
import {
  isModelAllowedForProject,
  ProjectAgentNotAllowedError,
  resolveProjectDefaultModel,
} from './project-agent-policy.js';
import {
  CLAUDE_MODELS,
  CLAUDE_MORE_MODELS,
  DEFAULT_MODEL,
  isProjectSessionModel,
  projectSettingsStore,
  sortModelIds,
} from './server-support.js';

interface ServerModels {
  availableModels: (options?: {
    allowLegacyCodexFallback?: boolean;
    viewer?: string | undefined;
  }) => Promise<ModelList>;
  projectAgentRejection: (model: string, projectId: string) => Promise<string | undefined>;
  projectDefaultModel: (projectId: string | null) => Promise<string | undefined>;
  isConfiguredProjectSessionModel: (model: string | undefined, viewer?: string) => Promise<boolean>;
}

export function createServerModels(ctx: ServerContext): ServerModels {
  const { app, deps } = ctx;
  // The usable model set for the picker (ADR 0001 / #143): Claude and Codex are
  // subscription-backed and therefore appear only when their login exists in Verity
  // settings. OpenCode provider-qualified ids still come from the configured backend.
  // This keeps the UI from offering engines that would immediately fail at runtime.
  const availableModels = async (
    options: { allowLegacyCodexFallback?: boolean; viewer?: string | undefined } = {},
  ): Promise<ModelList> => {
    const accounts = await modelAccounts(deps.eventStore, options.viewer);
    const claudeConfigured = accounts.claude;
    const codexConfigured = accounts.codex;
    let dynamicModels: string[] = [];
    if (deps.listModels) {
      try {
        dynamicModels = await deps.listModels();
      } catch (error) {
        app.log.error({ err: error }, 'verity: dynamic model list unavailable');
      }
    }
    // OpenCode models are the person's own provider's, never the instance's for
    // someone else.
    dynamicModels = [
      ...dynamicModels.filter((id) => !id.startsWith('verity/')),
      ...accounts.openCode.map((model) => `verity/${model}`),
    ];
    const seen = new Set<string>();
    const merged: string[] = [];
    const codexModels: string[] = [];
    let codexDefault: string | undefined;
    const add = (id: string) => {
      if (id.length === 0 || seen.has(id)) return;
      seen.add(id);
      merged.push(id);
    };
    if (claudeConfigured) for (const id of CLAUDE_MODELS) add(id);
    for (const id of dynamicModels) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (isCodexModel(id)) {
        if (codexConfigured && id !== CODEX_DEFAULT_MODEL && !seen.has(id)) {
          codexDefault ??= id;
          codexModels.push(id);
          add(id);
        }
        continue;
      }
      if (!id.includes('/')) {
        if (claudeConfigured) add(id);
        continue;
      }
      add(id);
    }
    // Spawn callers can use the authenticated CLI default even when discovery fails.
    // Keep it eligible when a project's rule excludes the global Claude default.
    if (options.allowLegacyCodexFallback === true && codexConfigured && codexModels.length === 0) {
      add(CODEX_DEFAULT_MODEL);
    }
    const models = sortModelIds(merged);
    const modelOrder = [
      ...models.filter((id) => !id.includes('/')),
      ...codexModels,
      ...models.filter((id) => id.includes('/') && !isCodexModel(id)),
    ];
    const fallbackDefault =
      codexDefault ??
      (options.allowLegacyCodexFallback === true && codexConfigured
        ? CODEX_DEFAULT_MODEL
        : models.find((model) => !model.startsWith('verity/')));
    const moreModels = [...(claudeConfigured ? CLAUDE_MORE_MODELS : []), ...codexModels.slice(3)];
    return {
      models,
      ...(codexModels.length > 0 ? { modelOrder } : {}),
      ...(moreModels.length > 0 ? { moreModels } : {}),
      ...(claudeConfigured && models.includes(DEFAULT_MODEL)
        ? { default: DEFAULT_MODEL }
        : fallbackDefault !== undefined
          ? { default: fallbackDefault }
          : {}),
    };
  };
  /** Why the project's agent rule rejects `model`, or undefined when it is allowed. */
  const projectAgentRejection = async (
    model: string,
    projectId: string,
  ): Promise<string | undefined> => {
    const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(projectId);
    return isModelAllowedForProject(model, settings)
      ? undefined
      : new ProjectAgentNotAllowedError(model).message;
  };
  /** The model a project's new work starts with, honouring its agent rule. */
  const projectDefaultModel = async (projectId: string | null): Promise<string | undefined> => {
    const available = await availableModels();
    if (projectId === null) return available.default;
    const settings = await projectSettingsStore(deps.eventStore).getProjectSettings(projectId);
    return resolveProjectDefaultModel(available, settings, isProjectSessionModel);
  };
  const isConfiguredProjectSessionModel = async (
    model: string | undefined,
    viewer?: string,
  ): Promise<boolean> => {
    if (!isProjectSessionModel(model)) return false;
    if (model === undefined || !model.startsWith('verity/')) return true;
    return (await modelAccounts(deps.eventStore, viewer)).openCode.includes(
      model.slice('verity/'.length),
    );
  };

  return {
    availableModels,
    projectAgentRejection,
    projectDefaultModel,
    isConfiguredProjectSessionModel,
  };
}
