import { randomUUID } from 'node:crypto';
import { assistantRequestSchema } from '@verity/events';
import type { AssistantMode, EventStore } from '@verity/store';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';

export interface AssistantToolDeps {
  eventStore: EventStore;
  /** The user the calling turn runs for, from its prompt's `initiatedBy`. */
  initiator(sessionId: string, turnId: string): Promise<{ userId: string } | undefined>;
  /** Whether `userId` (undefined when auth is off) may use the project at this level. */
  permitted(
    userId: string | undefined,
    projectId: string,
    permission: 'read' | 'execute',
  ): Promise<boolean>;
}

/** Refuses every caller except the enabled assistant session. Role identity is the stored
 *  session id, never the session's name or anything the agent could claim. */
export async function requireAssistantSession(
  eventStore: EventStore,
  sessionId: string,
): Promise<void> {
  const settings = await eventStore.assistant.settings();
  if (settings.session_id !== sessionId)
    throw new ControlPlaneSessionAuthorityError('This tool belongs to the Verity assistant.');
  if (!settings.enabled)
    throw new ControlPlaneSessionAuthorityError(
      'The Verity assistant is disabled in system settings.',
    );
}

/** The assistant's grant for a project at `needed` or above, for the turn's user. A missing
 *  grant, a deleted project or a user who lost access all refuse the same way, so the error
 *  does not reveal which projects exist. */
export async function requireAssistantGrant(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string; projectId: string },
  needed: Exclude<AssistantMode, 'off'>,
): Promise<{ userId: string | undefined; projectName: string }> {
  await requireAssistantSession(deps.eventStore, input.sessionId);
  const grant = await deps.eventStore.assistant.grant(input.projectId);
  const project = await deps.eventStore.getProject(input.projectId);
  const initiator = await deps.initiator(input.sessionId, input.turnId);
  if (
    grant === undefined ||
    (grant.mode !== 'delegate' && grant.mode !== needed) ||
    project === undefined ||
    project.hiddenAt !== null ||
    project.archived === true ||
    !(await deps.permitted(
      initiator?.userId,
      input.projectId,
      needed === 'delegate' ? 'execute' : 'read',
    ))
  )
    throw new ControlPlaneSessionAuthorityError(
      needed === 'delegate'
        ? `The assistant may not hand work to project ${input.projectId}. Grant "Tasks and sessions" in its Agents settings.`
        : `The assistant has no access to project ${input.projectId}. Grant access in its Agents settings.`,
    );
  return { userId: initiator?.userId, projectName: `${project.owner}/${project.repo}` };
}

export async function executeAssistantTool(
  deps: AssistantToolDeps,
  input: { sessionId: string; turnId: string; request: unknown },
): Promise<Record<string, unknown>> {
  await requireAssistantSession(deps.eventStore, input.sessionId);
  const request = assistantRequestSchema.parse(input.request);
  if (request.action === 'projects') {
    const initiator = await deps.initiator(input.sessionId, input.turnId);
    const projects = new Map(
      (await deps.eventStore.listProjects()).map((project) => [project.id, project]),
    );
    const granted: { projectId: string; name: string; mode: AssistantMode }[] = [];
    for (const grant of await deps.eventStore.assistant.grants()) {
      const project = projects.get(grant.project_id);
      if (grant.mode === 'off' || !project || project.hiddenAt !== null || project.archived)
        continue;
      if (!(await deps.permitted(initiator?.userId, project.id, 'read'))) continue;
      granted.push({
        projectId: project.id,
        name: `${project.owner}/${project.repo}`,
        mode: grant.mode,
      });
    }
    return { projects: granted };
  }
  const { userId, projectName } = await requireAssistantGrant(
    deps,
    { ...input, projectId: request.projectId },
    'tasks',
  );
  // A task needs an owner. With auth off there is no initiator; the administrator who
  // enabled the assistant stands in, as the session runs on their behalf.
  const owner = userId ?? (await deps.eventStore.assistant.settings()).sponsor_user_id;
  if (!owner) throw new Error('No user to own the task; re-enable the assistant.');
  const task = await deps.eventStore.tasks.upsert({
    id: randomUUID(),
    ownerUserId: owner,
    projectId: request.projectId,
    sessionId: null,
    sourceSessionId: input.sessionId,
    origin: 'agent',
    title: request.title,
    detail: request.detail ?? null,
  });
  return { added: { id: task.id, title: task.title, project: projectName } };
}
