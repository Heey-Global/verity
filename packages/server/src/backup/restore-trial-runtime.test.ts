import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { InstallerRestoreTrial } from './restore-trial-runtime.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { BackupDeviceReview } from './device-review.js';
import type { RestoreJob } from './restore-job.js';
it.each(['staging', 'canonical'] as const)(
  'starts only the restricted %s trial and resumes explicit device review across worker restarts',
  async (target) => {
    const root = await mkdtemp(join(tmpdir(), 'trial-runtime-'));
    const job: RestoreJob = {
      format: 1,
      id: randomUUID(),
      installationId: randomUUID(),
      selection: {
        source: '/copied/backup',
        repository: randomUUID() + '-r1',
        sequence: 1,
        kind: 'manual',
        newIdentity: false,
      },
      verified: {
        image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        schema: 'schema',
        architecture: 'amd64',
        deploymentId: 'deployment',
        sourceInstallationId: randomUUID(),
      },
      phase: target === 'canonical' ? 'promoting' : 'starting-trial',
      startedAt: 1,
      updatedAt: 1,
    };
    const resources = restoreDatabaseResources(job);
    const state = join(root, job.id);
    await mkdir(state);
    if (target === 'canonical')
      await writeFile(
        join(state, 'database-canonicalized'),
        JSON.stringify({ jobId: job.id, manifestHash: job.verified!.manifestHash }),
      );
    await writeFile(
      join(state, 'database'),
      JSON.stringify({
        jobId: job.id,
        container: resources.container,
        database: resources.database,
        password: 'a'.repeat(64),
        network: resources.prefix,
      }),
    );
    await writeFile(
      join(state, 'devices'),
      JSON.stringify({ devices: ['reviewed-device'], revokedIds: [], findings: [] }),
    );
    const server = createServer((_request, response) => {
      response.end('{}');
    });
    const createContainer = vi.fn(async (spec: ContainerSpec) => {
      void spec;
      return { id: 'trial' };
    });
    const docker = {
      listContainers: async () => [],
      createContainer,
      startContainer: async () => {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(join(state, 'trial/trial.sock'), resolve);
        });
      },
    } as unknown as DockerClient;
    try {
      const runtime = new InstallerRestoreTrial({ docker, root, network: resources.prefix });
      if (target === 'canonical')
        await expect(runtime.start({ ...job, phase: 'trial' }, undefined, target)).rejects.toThrow(
          'promotion authority',
        );
      await runtime.start(job, undefined, target);
      expect(createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ['backup-restore-trial'],
          binds: [`${join(state, 'trial')}:/restore:rw`],
          readOnlyRootfs: true,
          restartPolicy: 'no',
          labels: resources.labels,
        }),
      );
      const spec = createContainer.mock.calls[0]?.[0];
      expect(spec).not.toHaveProperty('portBindings');
      expect(spec!.env).toContain(
        `VERITY_RESTORE_DATABASE_URL=postgres://${target === 'canonical' ? 'verity' : 'restore'}:${'a'.repeat(64)}@${resources.container}:5432/${target === 'canonical' ? 'verity' : resources.database}`,
      );
      await expect(runtime.reviewed(job)).rejects.toThrow('Explicit device review');
      const review = new BackupDeviceReview(join(state, 'trial'));
      const token = await review.create(['reviewed-device'], [], []);
      await review.accept(token, ['reviewed-device'], async () => {});
      await expect(
        new InstallerRestoreTrial({ docker, root, network: resources.prefix }).reviewed(job),
      ).resolves.toBeUndefined();
      await expect(
        runtime.reviewed({ ...job, selection: { ...job.selection, newIdentity: true } }),
      ).rejects.toThrow('cannot retain');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
