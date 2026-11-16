import type { DockerClient, DockerContainerSummary, ContainerInspect } from './docker.js';

const component = 'runner-cache-maintenance';
const managedName = /^verity-cache-maintenance-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export function isCacheHelper(candidate: DockerContainerSummary, projectId: string): boolean {
  return (
    candidate.labels?.['verity.project-id'] === projectId &&
    candidate.labels?.['verity.component'] === component &&
    candidate.names?.some((name) => managedName.test(name)) === true
  );
}

export function hasCacheHelperIdentity(candidate: DockerContainerSummary): boolean {
  return (
    candidate.labels?.['verity.component'] === component ||
    candidate.names?.some((name) => managedName.test(name)) === true
  );
}

type Verified = { candidate: DockerContainerSummary; inspect: ContainerInspect; since: number };
export interface CacheHelperRetention {
  removed: string[];
  retained: string[];
  blocked: boolean;
  blockedReason?: string;
}

/** Caller holds the project's lifecycle AND storage barriers, including result collection. */
export async function retainLatestCacheHelper(input: {
  docker: DockerClient;
  projectId: string;
  now?: number;
  /** GC may expire the retained last run under its existing seven-day policy. */
  expireAfterMs?: number;
  dryRun?: boolean;
}): Promise<CacheHelperRetention> {
  const { docker, projectId } = input;
  const result: CacheHelperRetention = { removed: [], retained: [], blocked: false };
  if (!docker.listContainers || !docker.removeStoppedContainer) {
    result.blocked = true;
    result.blockedReason = 'Cache helper inventory is unavailable';
    return result;
  }
  const now = input.now ?? Date.now();
  const inventory = await docker.listContainers();
  if (inventory.length > 1000)
    return {
      ...result,
      blocked: true,
      blockedReason: 'Cache helper inventory exceeds the verification limit',
    };
  const candidates = inventory.filter(
    (candidate) =>
      candidate.labels?.['verity.project-id'] === projectId && hasCacheHelperIdentity(candidate),
  );
  const verified: Verified[] = [];
  for (const candidate of candidates) {
    result.retained.push(candidate.id);
    if (!isCacheHelper(candidate, projectId)) {
      result.blockedReason ??= 'Cache helper ownership or identity could not be verified';
      result.blocked = true;
      continue;
    }
    const inspect = await docker.inspectContainer(candidate.id);
    const since =
      inspect.status === 'created'
        ? (candidate.created ?? NaN) * 1000
        : Date.parse(inspect.finishedAt ?? '');
    if (
      inspect.id !== candidate.id ||
      inspect.running ||
      !['created', 'exited', 'dead'].includes(inspect.status ?? '') ||
      inspect.status !== candidate.state ||
      !candidate.imageId ||
      inspect.imageId !== candidate.imageId ||
      inspect.labels?.['verity.project-id'] !== projectId ||
      inspect.labels?.['verity.component'] !== component ||
      !Number.isFinite(since) ||
      since <= 0 ||
      since > now
    ) {
      result.blockedReason ??= inspect.running
        ? 'Cache helper reports running; evidence retained'
        : 'Cache helper identity or stopped state could not be verified';
      result.blocked = true;
      continue;
    }
    verified.push({ candidate, inspect, since });
  }
  // Unknown runs may still own a fence or be the newest evidence. Don't guess or multiply them.
  if (result.blocked) return result;
  verified.sort((a, b) => b.since - a.since || a.candidate.id.localeCompare(b.candidate.id));
  // A created container has never run. Keeping it would fence project admission
  // indefinitely; remove it under these barriers instead of retaining empty evidence.
  const latestRun = verified.find((entry) => entry.inspect.status !== 'created');
  for (const saved of verified) {
    if (
      saved === latestRun &&
      (input.expireAfterMs === undefined || now - saved.since < input.expireAfterMs)
    )
      continue;
    // Re-read both identity sources at mutation time; a state change invalidates the pass.
    const current = (await docker.listContainers()).find(
      (candidate) => candidate.id === saved.candidate.id,
    );
    const inspect = await docker.inspectContainer(saved.candidate.id);
    if (
      !current ||
      !isCacheHelper(current, projectId) ||
      current.imageId !== saved.candidate.imageId ||
      current.state !== saved.inspect.status ||
      current.created !== saved.candidate.created ||
      inspect.id !== current.id ||
      inspect.running ||
      inspect.status !== saved.inspect.status ||
      inspect.imageId !== saved.inspect.imageId ||
      inspect.finishedAt !== saved.inspect.finishedAt ||
      inspect.labels?.['verity.project-id'] !== projectId ||
      inspect.labels?.['verity.component'] !== component
    ) {
      result.blockedReason = 'Cache helper identity or state changed during verification';
      result.blocked = true;
      break;
    }
    // Engine rejects a concurrent start. This API never forces removal or deletes volumes.
    if (!input.dryRun) await docker.removeStoppedContainer(current.id);
    result.removed.push(current.id);
    result.retained = result.retained.filter((id) => id !== current.id);
  }
  return result;
}
