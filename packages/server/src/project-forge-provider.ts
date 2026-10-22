import type { EventStore, ProjectRecord } from '@verity/store';
import type { ForgeProvider } from './forge-provider.js';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { ForgejoTransport } from './forgejo-transport.js';

/** Resolve afresh so CA and token rotation invalidate every credential-bearing operation. */
export async function projectForgeProvider(
  store: EventStore,
  github: ForgeProvider,
  project: Pick<ProjectRecord, 'kind' | 'owner' | 'repo' | 'forgeConnectionId'>,
): Promise<ForgeProvider | undefined> {
  if (project.kind !== 'forgejo') return github;
  if (!project.forgeConnectionId) return undefined;
  const connection = await store.forgeConnections.get(project.forgeConnectionId);
  if (!connection || connection.provider !== 'forgejo') return undefined;
  const token = async () =>
    (await store.forgeConnections.credentials(connection.id))?.personalToken ?? undefined;
  return createForgejoForgeProvider({
    transport: new ForgejoTransport(connection.baseUrl, token, connection.customCaPem),
    token,
    // The project binding is authoritative, including for worktrees whose remote
    // was edited inside the sandbox. It never grants access to another repository.
    identityFor: () => () => Promise.resolve({ owner: project.owner, repo: project.repo }),
  });
}
