import type { ProjectRecord } from '@verity/mobile';

/** Status events originate outside the overview and do not own its per-person
 *  view: fold state and dismissed Home items come only from the overview list. */
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
