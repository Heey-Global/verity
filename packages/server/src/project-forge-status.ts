import { createHash } from 'node:crypto';
import type { ProjectRecord } from '@verity/store';
import type { ForgeProvider, PullRequestStatus } from './forge-provider.js';
import { createForgeStatusCache, type ForgeStatusIdentity } from './forge-status-cache.js';

/** Owns the same observation generation across UI, supervision and provider snapshots. */
export function createProjectForgeStatusReader(
  providerFor: (project: ProjectRecord) => Promise<ForgeProvider | undefined>,
) {
  const shared = createForgeStatusCache();
  const scopes = new Map<string, ForgeStatusIdentity>();
  const providers = new WeakMap<ForgeProvider, number>();
  let nextProvider = 0;
  const statusIdentity = async (
    project: ProjectRecord,
    provider: ForgeProvider,
  ): Promise<ForgeStatusIdentity> => {
    const token = await provider.mintProjectToken(project);
    if (!token) throw new Error('Forge credentials unavailable');
    let version = providers.get(provider);
    if (version === undefined) {
      version = ++nextProvider;
      providers.set(provider, version);
    }
    const authority = `${project.forgeConnectionId ?? 'github'}:${version}:${createHash('sha256').update(token).digest('hex')}`;
    return { authority, owner: project.owner, repo: project.repo };
  };
  const readProjectStatus = async (
    project: ProjectRecord,
    branch: string,
    remember = true,
  ): Promise<PullRequestStatus | null> => {
    if (project.kind === 'local' || project.kind === 'control_plane') return null;
    const provider = await providerFor(project);
    if (!provider?.repositoryPrService) return null;
    const identity = await statusIdentity(project, provider);
    if (remember) {
      scopes.delete(project.id);
      scopes.set(project.id, identity);
      while (scopes.size > 4096) scopes.delete(scopes.keys().next().value!);
    }
    return shared.read(identity, branch, (observationScope) =>
      provider.repositoryPrService!(project, observationScope).prStatusForBranch(branch),
    );
  };
  return {
    readProjectStatus,
    statusIdentity,
    invalidateStatus: (identity: ForgeStatusIdentity) => shared.invalidate(identity),
    invalidateProjectStatus: (projectId: string) => {
      const identity = scopes.get(projectId);
      if (identity) shared.invalidate(identity);
    },
  };
}
