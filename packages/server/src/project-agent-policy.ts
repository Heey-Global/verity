import { CODEX_DEFAULT_MODEL, isCodexModel } from '@verity/session';
import { PROJECT_AGENTS, type ProjectAgent } from '@verity/store';

export { PROJECT_AGENTS, type ProjectAgent };

/** The slice of `GET /models` the policy filters and resolves defaults from. */
export interface PolicyModelList {
  models: string[];
  modelOrder?: string[] | undefined;
  moreModels?: string[] | undefined;
  default?: string | undefined;
  /** Set on a project-narrowed list whose project excludes some agents. */
  allowedAgents?: ProjectAgent[] | undefined;
}

/** The project settings the policy reads; null means the project has no settings row. */
export interface ProjectAgentSettings {
  defaultModel: string | null;
  allowedAgents: readonly ProjectAgent[] | null;
}

/** Thrown when a project's agent rule rejects a model, so routes can answer 400. */
export class ProjectAgentNotAllowedError extends Error {
  constructor(readonly model: string) {
    super(`${agentDisplayName(modelAgent(model))} is not allowed in this project.`);
    this.name = 'ProjectAgentNotAllowedError';
  }
}

/** Thrown when no connected agent satisfies a project's agent rule. */
export class NoAllowedAgentError extends Error {
  constructor(allowed: readonly ProjectAgent[]) {
    super(
      `No allowed agent is connected for this project (allowed: ${allowed
        .map(agentDisplayName)
        .join(', ')}). Connect one or change the project's agents.`,
    );
    this.name = 'NoAllowedAgentError';
  }
}

/** The agent that runs a model id: `codex/…` is Codex, other provider ids are OpenCode. */
export function modelAgent(model: string): ProjectAgent {
  if (isCodexModel(model)) return 'codex';
  return model.includes('/') ? 'opencode' : 'claude';
}

function agentDisplayName(agent: ProjectAgent): string {
  return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'OpenCode';
}

/** Whether a project may run `model`; an unrestricted project allows every model. */
export function isModelAllowedForProject(
  model: string,
  settings: ProjectAgentSettings | null | undefined,
): boolean {
  const allowed = settings?.allowedAgents ?? null;
  return allowed === null || allowed.includes(modelAgent(model));
}

/** Picker order: the server's ranking when it sends one, otherwise Claude → Codex → OpenCode. */
function orderedModels(list: PolicyModelList): string[] {
  if (list.modelOrder !== undefined) return list.modelOrder;
  const rank = (model: string) => PROJECT_AGENTS.indexOf(modelAgent(model));
  return [...list.models].sort((a, b) => rank(a) - rank(b));
}

/**
 * The model a new project session starts with: the project's explicit default while
 * it is allowed, else the server default while it is allowed, else the first allowed
 * model in picker order ("Automatic"). Undefined when nothing allowed is usable.
 */
export function resolveProjectDefaultModel(
  list: PolicyModelList,
  settings: ProjectAgentSettings | null | undefined,
  usable: (model: string) => boolean = () => true,
): string | undefined {
  const allowed = (model: string) =>
    isModelAllowedForProject(model, settings) && list.models.includes(model) && usable(model);
  const explicit = settings?.defaultModel ?? null;
  if (explicit !== null && isModelAllowedForProject(explicit, settings) && usable(explicit))
    return explicit;
  // The server may advertise Codex's CLI default when authenticated catalog discovery fails.
  if (
    list.default !== undefined &&
    (allowed(list.default) ||
      (list.default === CODEX_DEFAULT_MODEL &&
        isModelAllowedForProject(list.default, settings) &&
        usable(list.default)))
  )
    return list.default;
  const more = new Set(list.moreModels ?? []);
  const ordered = orderedModels(list).filter(allowed);
  return ordered.find((model) => !more.has(model)) ?? ordered[0];
}

/** `GET /models` narrowed to a project's allowed agents, with its resolved default. */
export function filterModelListForProject(
  list: PolicyModelList,
  settings: ProjectAgentSettings | null | undefined,
  usable?: (model: string) => boolean,
): PolicyModelList {
  const keep = (model: string) =>
    isModelAllowedForProject(model, settings) && (usable?.(model) ?? true);
  const fallback = resolveProjectDefaultModel(list, settings, usable);
  const models = list.models.filter(keep);
  const moreModels = list.moreModels?.filter(keep);
  const modelOrder = list.modelOrder?.filter(keep);
  const allowedAgents = settings?.allowedAgents ?? null;
  return {
    models,
    ...(modelOrder !== undefined ? { modelOrder } : {}),
    ...(moreModels !== undefined && moreModels.length > 0 ? { moreModels } : {}),
    ...(fallback !== undefined && models.includes(fallback) ? { default: fallback } : {}),
    ...(allowedAgents !== null ? { allowedAgents: [...allowedAgents] } : {}),
  };
}
