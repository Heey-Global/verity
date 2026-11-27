import type { DomainEvent } from '@verity/events';
import { projectRecordSchema, type ProjectRecord } from '../api.js';

/**
 * What a project event (ADR 0033) changes in a project a view holds.
 *
 * - `patch` is applied at once, so Home, the project page and its settings
 *   show a sandbox that started, failed or went to sleep without waiting.
 * - `reload` asks the view to read the project again, because the routes add
 *   fields the event does not carry, such as the failure message.
 *
 * Undefined for events that do not concern projects.
 */
export interface ProjectEventUpdate {
  projectId: string;
  patch: (project: ProjectRecord) => ProjectRecord;
  reload: boolean;
}

const stateSchema = projectRecordSchema.shape.state;
const lifecycleStateSchema = projectRecordSchema.shape.lifecycleState;
const nameSchema = projectRecordSchema.shape.name;
const setupStatusSchema = projectRecordSchema.shape.setupStatus;
const sandboxUpdateSchema = projectRecordSchema.shape.sandboxUpdate;

/** Fields `project.changed` may carry beyond the name and setup status. Each
 * is checked against the project schema; one this app cannot read is left to
 * the read that follows. */
const PATCHABLE_FIELDS = [
  'latestReleaseTag',
  'latestReleaseName',
  'latestReleaseUrl',
  'latestReleasePublishedAt',
  'toolkitDrift',
] as const;

function patchedFields(patch: Record<string, unknown>): Partial<ProjectRecord> {
  const fields: Partial<ProjectRecord> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (!(field in patch)) continue;
    const parsed = projectRecordSchema.shape[field].safeParse(patch[field]);
    if (parsed.success) Object.assign(fields, { [field]: parsed.data });
  }
  return fields;
}

export function projectEventUpdate(event: DomainEvent): ProjectEventUpdate | undefined {
  switch (event.t) {
    case 'sandbox.lifecycle': {
      const state = stateSchema.safeParse(event.state);
      const lifecycleState = lifecycleStateSchema.safeParse(event.lifecycleState);
      // A state this app does not know yet is left to the read.
      if (!state.success || !lifecycleState.success) {
        return { projectId: event.projectId, patch: (project) => project, reload: true };
      }
      return {
        projectId: event.projectId,
        patch: (project) => {
          const next: ProjectRecord = { ...project, state: state.data };
          if (lifecycleState.data === undefined) delete next.lifecycleState;
          else next.lifecycleState = lifecycleState.data;
          if (event.warning !== undefined) next.provisionWarning = event.warning;
          return next;
        },
        reload: true,
      };
    }
    case 'sandbox.update': {
      // An older server sends only availability; a state this app cannot read
      // is left to the read.
      const parsed =
        event.update === undefined ? undefined : sandboxUpdateSchema.safeParse(event.update);
      const sandboxUpdate = parsed?.success === true ? parsed.data : undefined;
      return {
        projectId: event.projectId,
        patch: (project) => (sandboxUpdate === undefined ? project : { ...project, sandboxUpdate }),
        // The whole state needs no read; only availability does.
        reload: sandboxUpdate === undefined,
      };
    }
    case 'project.changed': {
      const name = nameSchema.safeParse(event.patch['name']);
      const setupStatus = setupStatusSchema.safeParse(event.patch['setupStatus']);
      const fields = patchedFields(event.patch);
      return {
        projectId: event.projectId,
        patch: (project) => ({
          ...project,
          ...('name' in event.patch && name.success && name.data !== undefined
            ? { name: name.data }
            : {}),
          ...('setupStatus' in event.patch && setupStatus.success && setupStatus.data !== undefined
            ? { setupStatus: setupStatus.data }
            : {}),
          ...fields,
        }),
        // A read already in flight may still carry the old value; the read
        // that follows it settles on the new one.
        reload: true,
      };
    }
    default:
      return undefined;
  }
}
