import { DockerError, type DockerClient } from './docker.js';
import type { EventStore, ManagedDevServerInstanceRecord, ProjectRecord } from '@verity/store';
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

export async function managedSiblingEnvironment(
  servers: EventStore['managedDevServers'],
  projectId: string,
  sessionId: string,
  exceptServerId: string,
): Promise<Record<string, string>> {
  const [entries, instances] = await Promise.all([
    servers.list(projectId),
    servers.listInstances({ sessionId }),
  ]);
  const env: Record<string, string> = {};
  for (const instance of instances) {
    if (instance.serverId === exceptServerId) continue;
    if (instance.state !== 'running' && instance.state !== 'starting') continue;
    const entry = entries.find((value) => value.id === instance.serverId);
    if (entry)
      env[`VERITY_SERVER_${entry.nameKey}_URL`] =
        `http://127.0.0.1:${String(instance.sandboxPort)}`;
  }
  return env;
}

export async function isManagedSandboxRunning(
  docker: DockerClient,
  name: string,
): Promise<boolean> {
  try {
    return (await docker.inspectContainer(name)).running;
  } catch (error) {
    if (error instanceof DockerError && error.kind === 'container_not_found') return false;
    throw error;
  }
}

/** Stops a managed process unless its sandbox is confirmed gone. A deleted
 * sandbox has no process left to stop, so retrying it could never succeed and
 * would keep the instance marked running. */
export async function stopManagedServerUnlessGone(
  options: Pick<ManagedDevServerManagerOptions, 'runtime' | 'sandboxRunning'>,
  target: ProjectRecord,
  instanceId: string,
): Promise<void> {
  await options.runtime.stopManagedServer(target, instanceId).catch(async (error: unknown) => {
    if ((await options.sandboxRunning?.(target.containerName)) !== false) throw error;
  });
}

export async function stopPreviousManagedRun(
  options: Pick<ManagedDevServerManagerOptions, 'store' | 'runtime' | 'sandboxRunning'>,
  instance: ManagedDevServerInstanceRecord,
  inSandbox: (userId: string | null) => Promise<ProjectRecord>,
): Promise<ManagedDevServerInstanceRecord> {
  if (instance.previousRunSandboxUserId == null) return instance;
  const target = await inSandbox(instance.previousRunSandboxUserId || null);
  await stopManagedServerUnlessGone(options, target, instance.id);
  return (
    (await options.store.managedDevServers.updateInstance(instance.id, {
      previousRunSandboxUserId: null,
    })) ?? instance
  );
}
