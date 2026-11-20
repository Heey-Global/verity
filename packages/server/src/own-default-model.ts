import type { EventStore } from '@verity/store';

import { isModelAllowedForProject, ProjectAgentNotAllowedError } from './project-agent-policy.js';
import { projectSettingsStore } from './server-support.js';

/**
 * Each person's own default model for a project (ADR 0023 §3): a project has no
 * default every member shares, so no one's choice decides another's turns.
 */

/** A person's own default model for a project, hidden while the agent rule excludes it. */
export async function ownDefaultModel(
  store: EventStore,
  viewer: string,
  projectId: string,
  settings: Parameters<typeof isModelAllowedForProject>[1],
): Promise<string | null> {
  const model = await store.userProviderConnections.projectDefaultModel(viewer, projectId);
  return model !== null && isModelAllowedForProject(model, settings) ? model : null;
}

/** Sets a person's own default model for a project, within the project's agent rule. */
export async function setOwnDefaultModel(
  store: EventStore,
  projectId: string,
  viewer: string,
  model: string | null,
): Promise<{ defaultModel: string | null }> {
  model = model?.trim() || null;
  if (model !== null) {
    const settings = await projectSettingsStore(store).getProjectSettings(projectId);
    if (!isModelAllowedForProject(model, settings)) throw new ProjectAgentNotAllowedError(model);
  }
  await store.userProviderConnections.setProjectDefaultModel(viewer, projectId, model);
  // The project page reads the default from the project's settings, which a
  // project nobody has configured yet does not have.
  const settingsStore = projectSettingsStore(store);
  if ((await settingsStore.getProjectSettingsRaw(projectId)) === undefined)
    await settingsStore.updateProjectSettings(projectId, {});
  return { defaultModel: model };
}
