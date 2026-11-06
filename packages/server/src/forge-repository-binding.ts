import type { EventStore } from '@verity/store';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
type Binding = NonNullable<Awaited<ReturnType<GhTokenCapabilityRegistry['resolve']>>>;

/** A URL chooses only among current project assignments, never an arbitrary remote. */
export async function resolveForgeRepositoryBinding(
  store: EventStore,
  binding: Binding,
  hostname: string,
  path: string,
): Promise<Binding | Binding[] | undefined> {
  if (hostname === 'ghcr.io') return binding;
  const repositories = await store.listProjectRepositories(binding.projectId);
  if (hostname === 'api.github.com' && path === '/graphql') {
    // GraphQL mutations identify nodes rather than URL repositories. The GitHub
    // adapter must validate every operation and remote node against one of these
    // current assignments before any caller payload can leave the broker.
    return repositories
      .filter(
        (repository) => repository.removedAt === null && (repository.kind ?? 'github') === 'github',
      )
      .map((repository) => ({
        ...binding,
        owner: repository.owner,
        repo: repository.repo,
        forgeConnectionId: repository.forgeConnectionId,
      }));
  }
  for (const repository of repositories) {
    if (
      repository.removedAt !== null ||
      !['github', 'forgejo'].includes(repository.kind ?? 'github')
    )
      continue;
    let host = 'github.com';
    let apiPrefix = '/repos/';
    let prefix = '';
    if (repository.kind === 'forgejo') {
      if (!repository.forgeConnectionId) continue;
      const connection = await store.forgeConnections.get(repository.forgeConnectionId);
      if (!connection) continue;
      const base = new URL(connection.baseUrl);
      host = base.host;
      prefix = base.pathname.replace(/\/$/u, '').toLowerCase();
      apiPrefix = `${prefix}/api/v1/repos/`;
    }
    const validHost =
      repository.kind === 'forgejo'
        ? hostname === host
        : ['github.com', 'api.github.com', 'uploads.github.com'].includes(hostname);
    if (!validHost) continue;
    const identity = `${repository.owner}/${repository.repo}`;
    const urlPath = path.split('?')[0]!.toLowerCase();
    const repoPath = identity.toLowerCase();
    const matches =
      urlPath === `${prefix}/${repoPath}.git` ||
      urlPath.startsWith(`${prefix}/${repoPath}.git/`) ||
      urlPath === `${prefix}/${repoPath}` ||
      urlPath.startsWith(`${prefix}/${repoPath}/`) ||
      urlPath === `${apiPrefix}${repoPath}`.toLowerCase() ||
      urlPath.startsWith(`${apiPrefix}${repoPath}/`.toLowerCase());
    if (matches)
      return {
        ...binding,
        owner: repository.owner,
        repo: repository.repo,
        forgeConnectionId: repository.forgeConnectionId,
      };
  }
  return undefined;
}
