import type { ProjectRecord, PublicPreviewShareRecord } from '@verity/store';
import type { PreviewShareManagerOptions } from './preview-share-manager.js';

/** A retained URL is intent, not evidence that its target is serving. Probe the
 * target on every activity check; an offline connector can itself be healthy. */
export async function previewTargetIsLive(
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
  try {
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
      await probes.staticDirectory(target, session?.worktree, share.staticPath);
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
  } catch {
    return false;
  }
}
