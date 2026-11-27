import type { ProjectRecord } from '@verity/mobile';

/** An action's answer does not own the person's view of a project: fold state
 *  and dismissed items come only from reads, which speak for that person. */
export function mergeProjectStatusMutation(
  current: ProjectRecord | undefined,
  updated: ProjectRecord,
): ProjectRecord {
  if (!current) return updated;
  const { inboxDismissed: _ignored, ...rest } = updated;
  return {
    ...rest,
    collapsed: current.collapsed,
    ...(current.inboxDismissed !== undefined ? { inboxDismissed: current.inboxDismissed } : {}),
  };
}
