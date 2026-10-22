import { createHash } from 'node:crypto';
import type { EventStore, ProjectRecord } from '@verity/store';
import type { ForgeProvider } from './forge-provider.js';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { ForgejoTransport } from './forgejo-transport.js';

// Store identity separates embedded servers; the bounded map never retains raw tokens.
const providers = new WeakMap<
  EventStore,
  Map<string, { version: string; provider: ForgeProvider }>
>();

/** Re-read credentials so rotation invalidates cached PR observations immediately. */
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
  const credential = await token();
  const key = JSON.stringify([connection.id, project.owner, project.repo]);
  const version = createHash('sha256')
    .update(JSON.stringify([connection.baseUrl, connection.customCaPem, credential]))
    .digest('hex');
  let cache = providers.get(store);
  if (!cache) {
    cache = new Map();
    providers.set(store, cache);
  }
  const existing = cache.get(key);
  if (existing?.version === version) return existing.provider;
  const provider = createForgejoForgeProvider({
    transport: new ForgejoTransport(connection.baseUrl, token, connection.customCaPem),
    token,
    // The project binding is authoritative, including for worktrees whose remote
    // was edited inside the sandbox. It never grants access to another repository.
    identityFor: () => () => Promise.resolve({ owner: project.owner, repo: project.repo }),
  });
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { version, provider });
  return provider;
}
