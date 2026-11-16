import { DockerError } from './docker.js';
import type { ProjectRecord, PublicPreviewShareRecord } from '@verity/store';
import type { PreviewShareManagerOptions } from './preview-share-manager.js';

/** A retained URL is intent, not evidence that its target is serving. Probe the
 * target on every activity check; an offline connector can itself be healthy. */
async function previewTargetEvidence(
  share: PublicPreviewShareRecord,
  options: PreviewShareManagerOptions,
  probes: {
    sandbox: (project: ProjectRecord, managedInstanceId: string | null) => Promise<ProjectRecord>;
    sessionPort: (project: ProjectRecord, worktree: string, port: number) => Promise<boolean>;
    staticDirectory: (
      project: ProjectRecord,
      worktree: string | undefined,
      path: string,
    ) => Promise<void>;
  },
): Promise<boolean> {
  if (
    share.state !== 'active' ||
    share.expiresAt.getTime() <= (options.now?.() ?? new Date()).getTime()
  )
    return false;
  const project = await options.store.getProject(share.projectId);
  if (!project || project.state !== 'active') return false;
  const target = await probes.sandbox(project, share.managedInstanceId ?? null);
  if (!(await options.docker.inspectContainer(target.containerName)).running) return false;
  const session = share.sessionId ? await options.store.getSession(share.sessionId) : undefined;
  if (share.sessionId && session?.projectId !== project.id) return false;
  if (share.managedInstanceId) {
    const instance = await options.store.managedDevServers.getInstance(share.managedInstanceId);
    if (
      !instance ||
      instance.projectId !== project.id ||
      instance.sessionId !== share.sessionId ||
      instance.desired !== 'running' ||
      instance.state !== 'running'
    )
      return false;
    return ((await options.listListeningProcesses?.(target)) ?? []).some(
      (listener) => listener.instanceId === instance.id && listener.port === instance.sandboxPort,
    );
  }
  if (share.targetKind === 'static-folder' && share.staticPath) {
    try {
      await probes.staticDirectory(target, session?.worktree, share.staticPath);
    } catch (error) {
      if (confirmedInvalidDirectory(error)) return false;
      throw error;
    }
    return true;
  }
  if (share.devServerId) {
    const devServer = await options.store.getDevServer(share.devServerId);
    return (
      !!devServer &&
      devServer.projectId === project.id &&
      devServer.containerPort === String(share.targetPort) &&
      (await options.isDevServerRunning({ project: target, devServer }))
    );
  }
  return (
    !!session &&
    share.targetPort !== null &&
    (await probes.sessionPort(target, session.worktree, share.targetPort))
  );
}

/** Permission/I/O failures leave evidence unknown; absence and unsafe paths do not. */
function confirmedInvalidDirectory(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth++, error = error.cause) {
    if ('code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return true;
    if (
      error.message === 'unsafe static directory' ||
      error.message === 'static path contains a symlink'
    )
      return true;
  }
  return false;
}

export async function previewTargetIsLive(
  ...args: Parameters<typeof previewTargetEvidence>
): Promise<boolean> {
  try {
    return await previewTargetEvidence(...args);
  } catch (error) {
    if (error instanceof DockerError && error.kind === 'container_not_found') return false;
    throw error;
  }
}

/** Connector absence is offline; transport failure cannot erase recovery obligations. */
export async function previewConnectorIsLive(
  docker: PreviewShareManagerOptions['docker'],
  id: string,
): Promise<boolean> {
  try {
    const connector = await docker.inspectContainer(id);
    return connector.running && !connector.env?.includes('VERITY_PREVIEW_OFFLINE=1');
  } catch (error) {
    if (error instanceof DockerError && error.kind === 'container_not_found') return false;
    throw error;
  }
}
