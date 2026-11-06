import type { EventStore } from '@verity/store';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
type Binding = NonNullable<Awaited<ReturnType<GhTokenCapabilityRegistry['resolve']>>>;

/** A URL chooses only among current project assignments, never an arbitrary remote. */
export async function resolveForgeRepositoryBinding(
  store: EventStore,
  binding: Binding,
  hostname: string,
  path: string,
): Promise<Binding | undefined> {
  if (hostname === 'ghcr.io') return binding;
  const repositories = await store.listProjectRepositories(binding.projectId);
  for (const repository of repositories) {
    if (
      repository.removedAt !== null ||
      !['github', 'forgejo'].includes(repository.kind ?? 'github')
    )
      continue;
    let host = 'github.com';
    let apiPrefix = '/repos/';
    if (repository.kind === 'forgejo') {
      if (!repository.forgeConnectionId) continue;
      const connection = await store.forgeConnections.get(repository.forgeConnectionId);
      if (!connection) continue;
      host = new URL(connection.baseUrl).host;
      apiPrefix = '/api/v1/repos/';
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
      urlPath === `/${repoPath}.git` ||
      urlPath.startsWith(`/${repoPath}.git/`) ||
      urlPath === `${apiPrefix}${repoPath}`.toLowerCase() ||
      urlPath.startsWith(`${apiPrefix}${repoPath}/`.toLowerCase());
    const legacyGraphql =
      repository.isDefault && hostname === 'api.github.com' && urlPath === '/graphql';
    if (matches || legacyGraphql)
      return {
        ...binding,
        owner: repository.owner,
        repo: repository.repo,
        forgeConnectionId: repository.forgeConnectionId,
      };
  }
  return undefined;
}
