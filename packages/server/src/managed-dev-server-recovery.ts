import type { ProjectRecord } from '@verity/store';
import type { ManagedDevServerManagerOptions } from './managed-dev-server-manager.js';

/** Recovery must probe the replacement, never reuse pre-replacement liveness. */
export async function verifyRecoveryInstances(
  options: Pick<ManagedDevServerManagerOptions, 'store' | 'runtime'>,
  inSandbox: (project: ProjectRecord, userId: string | null) => Promise<ProjectRecord>,
  ids: readonly string[],
): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const id of ids) {
    const instance = await options.store.managedDevServers.getInstance(id);
    if (instance?.desired !== 'running' || instance.state !== 'running') continue;
    const project = await options.store.getProject(instance.projectId);
    if (!project) continue;
    const target = await inSandbox(project, instance.lastRunUserId);
    const listeners = await options.runtime.listListeningProcesses(target, { fresh: true });
    if (
      listeners.some(
        (listener) => listener.instanceId === id && listener.port === instance.sandboxPort,
      )
    )
      verified.add(id);
  }
  return verified;
}

export async function stopOrphanManagedProcesses(
  options: Pick<ManagedDevServerManagerOptions, 'store' | 'runtime'>,
  project: ProjectRecord,
  tags: ReadonlySet<string>,
): Promise<void> {
  // Rows may have been deleted or stopped while the sandbox was paused.
  const wanted = new Set(
    (
      await options.store.managedDevServers.listInstances({
        projectId: project.id,
        desired: 'running',
      })
    ).map((instance) => instance.id),
  );
  for (const tag of tags) {
    if (!wanted.has(tag))
      await options.runtime.stopManagedServer(project, tag).catch(() => undefined);
  }
}
