import { DockerError, type DockerClient } from './docker.js';

/** A standby generation must not collect the serving generation's connectors. */
export async function sweepOrphanedLocalPreviews(
  docker: Pick<DockerClient, 'listContainers' | 'inspectContainer' | 'removeContainer'>,
  owner: string,
  ownsConnector: (id: string, shareId?: string) => boolean,
): Promise<void> {
  for (const container of (await docker.listContainers?.()) ?? []) {
    if (
      container.labels?.['verity.component'] !== 'local-preview-connector' ||
      ownsConnector(container.id, container.labels?.['verity.local-preview-share-id'])
    )
      continue;
    const creator = container.labels['verity.local-preview-server'];
    // Unlabelled ownership is not evidence that another generation has stopped.
    if (!creator) continue;
    if (creator !== owner) {
      try {
        if ((await docker.inspectContainer(creator)).running) continue;
      } catch (error) {
        if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
      }
    }
    try {
      await docker.removeContainer(container.id);
    } catch (error) {
      if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
    }
  }
}
