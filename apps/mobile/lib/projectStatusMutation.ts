import type { ProjectRecord } from '@verity/mobile';

/** Status events originate outside the overview and do not own its fold state. */
export function mergeProjectStatusMutation(
  current: ProjectRecord | undefined,
  updated: ProjectRecord,
): ProjectRecord {
  return current ? { ...updated, collapsed: current.collapsed } : updated;
}
