import { expect, it, vi } from 'vitest';
import { DockerError } from './docker.js';
import { sweepOrphanedLocalPreviews } from './local-preview-orphans.js';

function fixture() {
  const container = (id: string, owner?: string) => ({
    id,
    imageId: 'image',
    labels: {
      'verity.component': 'local-preview-connector',
      ...(owner ? { 'verity.local-preview-server': owner } : {}),
    },
  });
  const docker = {
    listContainers: vi.fn(async () => [
      container('own-live', 'candidate'),
      container('own-old', 'candidate'),
      container('serving-live', 'serving'),
      container('missing-owner', 'gone'),
      container('unknown'),
    ]),
    inspectContainer: vi.fn(async (id: string) => {
      if (id === 'gone') throw new DockerError({ kind: 'container_not_found', id });
      return { id, running: true };
    }),
    removeContainer: vi.fn(async () => {}),
  };
  return docker;
}
it('preserves live generations and collects only demonstrably orphaned connectors', async () => {
  const docker = fixture();
  await sweepOrphanedLocalPreviews(docker, 'candidate', (id) => id === 'own-live');
  expect(docker.removeContainer.mock.calls).toEqual([['own-old'], ['missing-owner']]);
  expect(docker.inspectContainer).toHaveBeenCalledWith('serving');
});
it('does not interpret a Docker outage as an absent owner', async () => {
  const docker = fixture();
  docker.inspectContainer.mockRejectedValue(
    new DockerError({ kind: 'network', cause: new Error('offline') }),
  );
  await expect(
    sweepOrphanedLocalPreviews(docker, 'candidate', () => true),
  ).resolves.toBeUndefined();
  await expect(
    sweepOrphanedLocalPreviews(docker, 'candidate', (id) => id !== 'serving-live'),
  ).rejects.toThrow();
  expect(docker.removeContainer).not.toHaveBeenCalled();
});
