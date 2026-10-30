import type { ProjectRecord } from '@verity/store';
import type { DockerClient, DockerContainerSummary, DockerImageSummary } from './docker.js';

const DAY = 24 * 60 * 60_000;
const projectLabel = 'verity.project-id';
const componentLabel = 'verity.component';
const generationLabel = 'verity.container-generation';
const serviceLabel = 'com.docker.compose.service';
const composeLabel = 'com.docker.compose.project';
const relay = (c: DockerContainerSummary) =>
  ['project-relay', 'project-broker-relay'].includes(c.labels?.[componentLabel] ?? '');
const stopped = (c: DockerContainerSummary) =>
  ['exited', 'created', 'dead'].includes(c.state ?? '');
function repositories(image: DockerImageSummary): string[] {
  return [...image.repoTags, ...image.repoDigests].map((ref) =>
    ref.split('@')[0]!.replace(/:[^/:]+$/, ''),
  );
}
function superseded(c: DockerContainerSummary, images: DockerImageSummary[]): boolean {
  const old = images.find((i) => i.id === c.imageId);
  if (!old) return false;
  const repos = repositories(old).filter(
    (r) =>
      r.startsWith('verity-devc-') ||
      [
        'ghcr.io/heey-global/verity/verity-sandbox',
        'ghcr.io/heey-global/verity/verity-project-relay',
      ].includes(r),
  );
  return images.some(
    (i) =>
      i.id !== old.id && i.created > old.created && repositories(i).some((r) => repos.includes(r)),
  );
}

/** All mutations run under the same barriers used by project starts and previews. */
export async function retireStoppedContainers(input: {
  docker: DockerClient;
  listProjects: () => Promise<ProjectRecord[]>;
  withProjectMutation: (projectId: string, run: () => Promise<void>) => Promise<void>;
  now?: number;
  dryRun?: boolean;
}): Promise<{
  removed: string[];
  errors: string[];
  retained: Array<{ name: string; reason: string }>;
}> {
  const result = {
    removed: [] as string[],
    errors: [] as string[],
    retained: [] as Array<{ name: string; reason: string }>,
  };
  const keep = (c: DockerContainerSummary, reason: string) => {
    result.retained.push({ name: c.names?.[0] ?? c.id, reason });
  };
  const { docker } = input;
  if (!docker.listContainers || !docker.listImages || !docker.removeStoppedContainer) return result;
  const now = input.now ?? Date.now();
  const projects = await input.listProjects(); // A failed inventory must not mean all projects were deleted.
  await docker.listImages(); // Inventory errors must fail closed.
  const containers = await docker.listContainers();
  const heldProjects = new Set(projects.map((p) => p.id));
  for (const candidate of containers) {
    if (!stopped(candidate)) continue;
    const projectId = candidate.labels?.[projectLabel];
    if (!projectId) {
      keep(candidate, 'No project identity; outside managed ownership');
      continue;
    }
    const maintenance =
      candidate.labels?.[componentLabel] === 'storage-maintenance' &&
      candidate.names?.some((name) => /^verity-query-[a-f0-9-]{36}$/.test(name));
    const project = projects.find((p) => p.id === projectId);
    const ownedSandbox =
      !relay(candidate) &&
      project?.containerName !== undefined &&
      candidate.names?.includes(project.containerName);
    // An orphan still needs identity labels; names or image ancestry alone are insufficient.
    if (
      !maintenance &&
      !relay(candidate) &&
      !ownedSandbox &&
      !candidate.labels?.[generationLabel]
    ) {
      keep(candidate, 'Container ownership is ambiguous');
      continue;
    }
    try {
      await input.withProjectMutation(projectId, async () => {
        const freshProjects = await input.listProjects();
        const latestProject = freshProjects.find((p) => p.id === projectId);
        if (
          !maintenance &&
          latestProject &&
          !['sleeping', 'absent', 'failed'].includes(latestProject.state)
        ) {
          keep(candidate, 'Project is active or changing state');
          return;
        }
        if (!maintenance && latestProject?.imageOverrideRef) {
          keep(candidate, 'Explicit project image override');
          return;
        }
        const current = (await docker.listContainers!()).find((c) => c.id === candidate.id);
        if (!current || !stopped(current) || current.imageId !== candidate.imageId) return;
        const inspect = await docker.inspectContainer(current.id);
        if (
          inspect.running ||
          inspect.status !== current.state ||
          !['exited', 'created', 'dead'].includes(inspect.status ?? '') ||
          inspect.imageId !== current.imageId
        )
          return;
        const since =
          inspect.status === 'created'
            ? (current.created ?? NaN) * 1000
            : Date.parse(inspect.finishedAt ?? '');
        const grace = latestProject && !maintenance ? DAY : 7 * DAY;
        if (!Number.isFinite(since) || since <= 0) {
          keep(current, 'Stop time is unknown');
          return;
        }
        if (now - since < grace) {
          keep(current, `Stopped-container grace period (${grace / DAY} days)`);
          return;
        }
        if (!maintenance && latestProject && !superseded(current, await docker.listImages!())) {
          keep(current, 'No newer image in the managed repository');
          return;
        }
        // A relay may only be retired with its stopped sandbox generation, never independently of a running sandbox.
        if (
          relay(current) &&
          (await docker.listContainers!()).some(
            (c) =>
              c.labels?.[projectLabel] === projectId &&
              !relay(c) &&
              c.labels?.[generationLabel] === current.labels?.[generationLabel] &&
              !stopped(c),
          )
        ) {
          keep(current, 'Relay generation still has a running sandbox');
          return;
        }
        if (!latestProject && heldProjects.has(projectId)) return; // Project changed during the pass; retry next time.
        if (!input.dryRun) await docker.removeStoppedContainer!(current.id);
        result.removed.push(current.names?.[0] ?? current.id);
      });
    } catch (error) {
      result.errors.push(
        `${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

/** Reconcile old successful Compose init containers only after a newer server is running. */
export async function retireCompletedUpdateContainers(
  docker: Pick<DockerClient, 'listContainers' | 'inspectContainer' | 'removeStoppedContainer'>,
  completedDeployment?: { composeProject: string },
): Promise<string[]> {
  if (!docker.listContainers || !docker.removeStoppedContainer) return [];
  const removed: string[] = [];
  for (const c of await docker.listContainers()) {
    if (
      c.state !== 'exited' ||
      !['verity-agent-seed', 'verity-managed-data-init'].includes(c.labels?.[serviceLabel] ?? '')
    )
      continue;
    const project = c.labels?.[composeLabel];
    if (!project || (completedDeployment && project !== completedDeployment.composeProject))
      continue;
    const inspect = await docker.inspectContainer(c.id);
    if (inspect.running || inspect.status !== 'exited' || inspect.exitCode !== 0) continue;
    // Re-list at mutation time; the running consumer establishes successful bootstrap completion.
    const ready =
      completedDeployment !== undefined ||
      (await docker.listContainers()).some(
        (server) =>
          server.state === 'running' &&
          Number.isFinite(c.created) &&
          Number.isFinite(server.created) &&
          server.created! > c.created! &&
          (completedDeployment !== undefined || server.imageId !== c.imageId) &&
          server.labels?.[composeLabel] === project &&
          server.labels?.[serviceLabel] === 'verity-server',
      );
    if (!ready) continue;
    await docker.removeStoppedContainer(c.id);
    removed.push(c.names?.[0] ?? c.id);
  }
  return removed;
}
