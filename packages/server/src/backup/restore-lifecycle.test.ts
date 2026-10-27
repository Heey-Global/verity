import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import { InstallerRestoreJob } from './restore-job.js';
import { createRestoreLifecycle } from './restore-lifecycle.js';

const fake = vi.hoisted(() => ({
  events: [] as string[],
  previousRunning: false,
  resume: vi.fn(),
  publish: vi.fn(),
  initialize: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('./restore-preparation.js', () => ({
  createRestorePreparation: () => ({
    verify: fake.verify,
    stage: async () => {},
    trial: async () => {
      fake.events.push('staged-trial');
    },
    review: async () => {},
    cleanup: async () => {
      fake.events.push('cleanup');
    },
  }),
}));
vi.mock('./restore-previous-runtime.js', () => ({
  RestorePreviousRuntime: class {
    async inspect() {
      return {
        containers: [],
        dataVolume: true,
        databaseVolume: true,
        managedVolume: true,
        hostConfiguration: false,
      };
    }
    async stop() {
      fake.events.push('fence-previous');
      fake.previousRunning = false;
    }
    async resume() {
      fake.events.push('resume-previous');
      fake.previousRunning = true;
      await fake.resume();
    }
  },
}));
vi.mock('./restore-promotion-storage.js', () => ({
  RestorePromotionStorage: class {
    async save() {
      fake.events.push('save');
    }
    publish = fake.publish;
    async rollback() {
      expect(fake.previousRunning).toBe(false);
      fake.events.push('restore-original');
    }
  },
}));
vi.mock('./restore-canonical-database.js', () => ({
  canonicalizeRestoreDatabase: async () => {
    fake.events.push('canonicalize');
  },
}));
vi.mock('./restore-canonical-runtime.js', () => ({
  startCanonicalRestoreDatabase: async () => {
    fake.events.push('canonical-database');
  },
  stopRestoreTrialRuntime: async () => {
    fake.events.push('stop-trial');
  },
  withCanonicalRestoreClient: async (
    _options: unknown,
    run: (client: unknown) => Promise<unknown>,
  ) => run({}),
}));
vi.mock('./restore-trial-runtime.js', () => ({
  InstallerRestoreTrial: class {
    async start() {
      fake.events.push('canonical-trial');
    }
    async reviewed() {}
  },
}));
vi.mock('./restore-final-review.js', () => ({
  recheckRestoreDevices: async () => {
    fake.events.push('final-authentication');
  },
}));
vi.mock('./restore-database-runtime.js', async (original) => ({
  ...(await original<typeof import('./restore-database-runtime.js')>()),
  removeRestoreDatabase: async () => {
    fake.events.push('remove-job-database');
  },
}));

it.each(['accept', 'abort', 'abort-resume', 'abort-promoted'] as const)(
  'composes restart-safe %s without publishing before the original installation is checkpointed',
  async (outcome) => {
    fake.events.length = 0;
    fake.previousRunning = false;
    fake.resume.mockReset().mockResolvedValue(undefined);
    fake.publish.mockReset().mockImplementation(async () => {
      fake.events.push('publish');
    });
    fake.initialize.mockReset().mockImplementation(async () => {
      fake.events.push('initialize');
    });
    fake.verify.mockReset().mockResolvedValue({
      image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      schema: 'schema',
      architecture: 'amd64',
      deploymentId: 'preserved',
      sourceInstallationId: randomUUID(),
    });
    const root = await mkdtemp(join(tmpdir(), 'restore-lifecycle-'));
    const adapters = () =>
      createRestoreLifecycle({
        docker: {} as DockerClient,
        root,
        liveRoot: '/srv/verity',
        tufCachePath: join(root, 'tuf'),
        host: { root, addresses: [] },
        hostRoot: join(root, 'host'),
        previousComposeProject: 'verity',
        recoveryKey: 'recovery-secret',
        masterPassword: 'master-secret',
        initialize: fake.initialize,
      });
    const manager = () => new InstallerRestoreJob(root, adapters());
    try {
      const job = await manager().begin({
        source: '/backup',
        repository: randomUUID() + '-r1',
        sequence: 1,
        kind: 'manual',
        newIdentity: false,
      });
      for (let n = 0; n < 4; n++) await manager().advance(job.id, 'recovery-secret');
      expect(fake.events).toEqual(['fence-previous', 'staged-trial']);
      if (outcome !== 'accept' && outcome !== 'abort-promoted')
        fake.publish.mockImplementationOnce(async () => {
          fake.events.push('publish');
          throw new Error('interrupted publication');
        });
      if (outcome === 'accept') {
        await manager().advance(job.id, 'recovery-secret');
        expect(fake.events).toEqual([
          'fence-previous',
          'staged-trial',
          'canonicalize',
          'fence-previous',
          'stop-trial',
          'save',
          'publish',
          'canonical-database',
          'canonical-trial',
        ]);
        fake.initialize.mockRejectedValueOnce(new Error('helper unavailable'));
        await expect(manager().advance(job.id, 'recovery-secret')).rejects.toThrow(
          'helper unavailable',
        );
        expect((await manager().status())!.phase).toBe('accepted');
        await manager().advance(job.id, 'recovery-secret');
        expect(fake.events.filter((event) => event === 'publish')).toHaveLength(1);
        expect(fake.events.slice(-2)).toEqual(['final-authentication', 'initialize']);
      } else {
        if (outcome === 'abort-promoted') await manager().advance(job.id, 'recovery-secret');
        else
          await expect(manager().advance(job.id, 'recovery-secret')).rejects.toThrow(
            'interrupted publication',
          );
        if (outcome === 'abort-resume') {
          fake.resume.mockRejectedValueOnce(new Error('interrupted after resume'));
          await expect(manager().abort(job.id)).rejects.toThrow('interrupted after resume');
          expect(fake.previousRunning).toBe(true);
          expect((await manager().status())!.phase).toBe('aborting');
        }
        await manager().abort(job.id);
        expect(fake.events.slice(-6)).toEqual([
          'fence-previous',
          'stop-trial',
          'remove-job-database',
          'restore-original',
          'resume-previous',
          'cleanup',
        ]);
        expect((await manager().status())!.phase).toBe('aborted');
      }
      for (const name of ['job', join(job.id, 'previous-runtime'), join(job.id, 'promotion')]) {
        const persisted = await readFile(join(root, name), 'utf8');
        expect(persisted).not.toContain('recovery-secret');
        expect(persisted).not.toContain('master-secret');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
