/**
 * What a resource invalidation means for the overview's domain events (ADR
 * 0033). Writes through the HTTP routes and server conditions without an
 * event of their own (QA and repair state, vulnerability findings, a finished
 * pull request read) announce themselves as invalidations of the paths they
 * change. These functions name the entity whose views must read it again, so
 * clients on the topic protocol learn of them without watching the paths.
 */

/** Project subresources that the project routes do not show: reading the
 * project again for them would only cost every viewer a request. */
const PROJECT_FAMILIES_OUTSIDE_THE_OVERVIEW: ReadonlySet<string> = new Set([
  'knowledge',
  'vulnerability-scan',
  'public-shares',
  'local-shares',
  'public-static-shares',
]);

/** Session subresources whose changes cannot alter the branch list, as the
 * resource observer already treats them. */
const SESSION_FAMILIES_OUTSIDE_THE_BRANCHES: ReadonlySet<string> = new Set([
  'seen',
  'links',
  'linked-message-approvals',
  'permissions',
  'queue',
  'activity',
  'google-status',
  'vulnerability-scan',
]);

function segments(path: string): string[] {
  return path.split('?')[0]!.split('/');
}

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The project list as a whole: a reorder, a new project. */
export const ALL_PROJECTS: unique symbol = Symbol('all projects');

/**
 * The project whose routes an invalidation of `path` concerns,
 * {@link ALL_PROJECTS} for the list as a whole, or undefined when it concerns
 * no project or nothing the project routes show.
 */
export function invalidatedProject(path: string): string | typeof ALL_PROJECTS | undefined {
  const [, collection, id, family] = segments(path);
  if (collection !== 'projects') return undefined;
  if (id === undefined || id === '' || id === 'order') return ALL_PROJECTS;
  if (family !== undefined && PROJECT_FAMILIES_OUTSIDE_THE_OVERVIEW.has(family)) return undefined;
  return decoded(id);
}

/** The session whose branch list an invalidation of `path` may have changed. */
export function invalidatedBranches(path: string): string | undefined {
  const [, collection, id, family] = segments(path);
  if (collection !== 'sessions' || id === undefined || id === '') return undefined;
  if (family !== undefined && SESSION_FAMILIES_OUTSIDE_THE_BRANCHES.has(family)) return undefined;
  return decoded(id);
}
