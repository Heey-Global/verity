import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import { RestorePreviousRuntime } from './restore-previous-runtime.js';

it('keeps previous container IDs and restart intent across interrupted stop and repeated rollback', async () => {
  const job = { id: randomUUID() };
  const containers = [
    {
      id: 'a'.repeat(64),
      name: 'verity-server',
      running: true,
      policy: 'unless-stopped',
      retries: 0,
      labels: { 'com.docker.compose.project': 'verity' },
    },
    {
      id: 'b'.repeat(64),
      name: 'verity-updater',
      running: true,
      policy: 'on-failure',
      retries: 5,
      labels: { 'com.docker.compose.project': 'verity' },
    },
    {
      id: 'c'.repeat(64),
      name: 'unrelated',
      running: true,
      policy: 'always',
      retries: 0,
      labels: {},
    },
  ];
  const changes: string[] = [];
  const renameContainer = vi.fn(async (id: string, name: string) => {
    const container = containers.find((container) => container.id === id)!;
    if (containers.some((container) => container.name === name)) throw new Error('name occupied');
    container.name = name;
    changes.push('rename:' + id);
  });
  let interrupted = false;
  const docker = {
    listContainers: async () =>
      containers.map((container) => ({
        id: container.id,
        names: [container.name],
        labels: container.labels,
      })),
    listVolumes: async () => [{ name: 'verity-data', labels: {} }],
    inspectContainer: async (id: string) => {
      const container = containers.find((container) => container.id === id)!;
      return {
        id,
        running: container.running,
        restartPolicy: container.policy,
        restartMaximumRetryCount: container.retries,
        mounts: [],
      };
    },
    renameContainer,
    setContainerRestartPolicy: async (
      id: string,
      policy: { name: string; maximumRetryCount: number },
    ) => {
      const container = containers.find((container) => container.id === id)!;
      container.policy = policy.name;
      container.retries = policy.maximumRetryCount;
      changes.push('policy:' + id);
    },
    stopContainer: async (id: string) => {
      expect(containers.slice(0, 2).every((container) => container.policy === 'no')).toBe(true);
      containers.find((container) => container.id === id)!.running = false;
      if (!interrupted) {
        interrupted = true;
        throw new Error('worker interrupted');
      }
    },
    startContainer: async (id: string) => {
      containers.find((container) => container.id === id)!.running = true;
    },
  } as unknown as DockerClient;
  const runtime = new RestorePreviousRuntime({
    docker,
    job,
    composeProject: 'verity',
    databaseVolume: 'verity_verity-db',
  });
  const previous = await runtime.inspect(true);
  expect(previous.containers).toHaveLength(2);
  await expect(runtime.stop(previous)).rejects.toThrow('worker interrupted');
  await runtime.stop(previous);
  await runtime.stop(previous);
  expect(containers.slice(0, 2).every((container) => !container.running)).toBe(true);
  expect(changes.slice(0, 2)).toEqual(['policy:' + 'a'.repeat(64), 'policy:' + 'b'.repeat(64)]);
  await runtime.resume(previous);
  await runtime.resume(previous);
  expect(
    containers.map(({ name, running, policy, retries }) => ({ name, running, policy, retries })),
  ).toEqual([
    { name: 'verity-server', running: true, policy: 'unless-stopped', retries: 0 },
    { name: 'verity-updater', running: true, policy: 'on-failure', retries: 5 },
    { name: 'unrelated', running: true, policy: 'always', retries: 0 },
  ]);
  expect(renameContainer).toHaveBeenCalledTimes(4);
  containers[1]!.name = 'unexpected';
  changes.length = 0;
  await expect(runtime.stop(previous)).rejects.toThrow('no longer matches');
  expect(changes).toEqual([]);
});
