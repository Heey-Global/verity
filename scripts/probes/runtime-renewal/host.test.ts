import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDockerClient } from '../../../packages/server/src/docker.js';
import {
  renewHostRuntimeService,
  HOST_RUNTIME_SERVICE_LABEL,
  parseRuntimeServiceRequirements,
} from '../../../packages/server/src/self-update/host-runtime-renewal.js';
import {
  readTargetHostRuntimes,
  reconcileHostRuntimes,
} from '../../../packages/server/src/self-update/host-runtimes.js';
import { verifyServerImage } from '../../../packages/server/src/self-update/server-image-verify.js';
import type { UpdateJournal } from '../../../packages/server/src/self-update/update-journal.js';

// Deliberately opt-in: this changes the runtime service on a disposable host.
describe.skipIf(process.env.VERITY_RUNTIME_RENEWAL_VM !== '1')(
  'runtime renewal on a disposable systemd host',
  () => {
    it('renews an old service while existing runc/runsc containers keep their original processes', async () => {
      expect((await readFile('/etc/verity-runtime-renewal-test-vm', 'utf8')).trim()).toBe(
        'disposable',
      );
      const previousDigest = process.env.VERITY_RUNTIME_BASE_IMAGE!;
      const targetDigest = process.env.VERITY_RUNTIME_TARGET_IMAGE!;
      await verifyServerImage(previousDigest);
      await verifyServerImage(targetDigest);
      const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
      await docker.pullImage!(previousDigest);
      await docker.pullImage!(targetDigest);
      const agent = JSON.parse(
        await readFile('/var/lib/verity/host-runtime/agent.json', 'utf8'),
      ) as { runtimeArtifacts?: string[] };
      expect(agent.runtimeArtifacts ?? []).not.toContain('archive');
      const requirements = await readTargetHostRuntimes(docker, targetDigest);
      expect(requirements?.archiveSha512).toBeDefined();
      const serviceRequirements = parseRuntimeServiceRequirements(
        JSON.parse((await docker.inspectImageLabels!(targetDigest))![HOST_RUNTIME_SERVICE_LABEL]!),
      );
      expect(serviceRequirements).not.toBeNull();
      const updateId = `qualification-${randomUUID()}`;
      const journal = {
        deploymentId: 'qualification',
        updateId,
        previousDigest,
        targetDigest,
      } as UpdateJournal;
      const containers: string[] = [];
      const snapshot = (
        id: string,
      ): { State: { Running: boolean; StartedAt: string }; RestartCount: number } =>
        JSON.parse(
          execFileSync('docker', ['inspect', '--format', '{{json .}}', id], { encoding: 'utf8' }),
        );
      try {
        for (const runtime of ['runc', 'runsc']) {
          const { id } = await docker.createContainer({
            image: previousDigest,
            name: `${updateId}-${runtime}`,
            runtime,
            user: '65534:65534',
            network: 'none',
            readOnlyRootfs: true,
            capDrop: ['ALL'],
            restartPolicy: 'no',
            entrypoint: ['bash'],
            command: ['-c', 'while true; do sleep 1; done'],
          });
          containers.push(id);
          await docker.startContainer(id);
        }
        const before = containers.map(snapshot);
        expect(before.every((entry) => entry.State.Running)).toBe(true);
        await reconcileHostRuntimes({
          docker,
          requirements: requirements!,
          requestId: updateId,
          serviceRequirements: serviceRequirements!,
          renewHostRuntimeService: () =>
            renewHostRuntimeService({
              docker,
              journal,
              runtimeHostPath: '/var/lib/verity/host-runtime',
              installerStatePath: '/etc/verity',
              verifyInstalled: async () => {
                const current = JSON.parse(
                  await readFile('/var/lib/verity/host-runtime/agent.json', 'utf8'),
                );
                expect(current.runtimeService.receipt).toMatchObject({ updateId, targetDigest });
              },
            }),
        });
        for (const [index, id] of containers.entries()) {
          const after = snapshot(id);
          expect(after.State.Running).toBe(true);
          expect(after.State.StartedAt).toBe(before[index]!.State.StartedAt);
          expect(after.RestartCount).toBe(before[index]!.RestartCount);
          execFileSync('docker', ['exec', id, 'true']);
        }
        // New sandbox creation must use the newly registered runtime successfully as well.
        const { id } = await docker.createContainer({
          image: targetDigest,
          name: `${updateId}-new`,
          runtime: 'runsc-project',
          network: 'none',
          entrypoint: ['true'],
        });
        containers.push(id);
        await docker.startContainer(id);
        expect(await docker.waitContainer!(id)).toBe(0);
      } finally {
        for (const id of containers) await docker.removeContainer(id);
      }
    }, 900_000);
  },
);
