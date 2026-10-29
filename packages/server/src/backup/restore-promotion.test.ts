import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { InstallerRestorePromotion, type RestorePromotionAdapters } from './restore-promotion.js';
import type { RestoreJob } from './restore-job.js';

async function fixture(crash: string) {
  const root = await mkdtemp(join(tmpdir(), 'restore-promotion-'));
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
    phase: 'promoting',
    startedAt: 1,
    updatedAt: 1,
  };
  let live = 'original';
  let saved: string | undefined;
  let stopped = false;
  let failed = false;
  const interrupt = (effect: string) => {
    if (!failed && crash === effect) {
      failed = true;
      throw new Error('interrupted ' + effect);
    }
  };
  const adapters: RestorePromotionAdapters = {
    inspect: vi.fn(async () => ({
      containers: [
        {
          id: 'a'.repeat(64),
          name: 'verity-server',
          running: true,
          restartPolicy: 'unless-stopped' as const,
          maximumRetryCount: 0,
        },
      ],
      dataVolume: true,
      databaseVolume: true,
      managedVolume: true,
      hostConfiguration: true,
    })),
    stop: vi.fn(async () => {
      stopped = true;
      interrupt('stop');
    }),
    save: vi.fn(async () => {
      expect(stopped).toBe(true);
      expect(live).toBe('original');
      saved = live;
      interrupt('save');
    }),
    publish: vi.fn(async () => {
      expect(saved).toBe('original');
      live = 'restored';
      interrupt('publish');
    }),
    start: vi.fn(async () => {
      expect(live).toBe('restored');
      interrupt('start');
    }),
    healthy: vi.fn(async () => {
      expect(live).toBe('restored');
      interrupt('healthy');
    }),
    rollback: vi.fn(async () => {
      if (saved) live = saved;
      stopped = false;
      interrupt('rollback');
    }),
  };
  return {
    root,
    job,
    adapters,
    live: () => live,
    stopped: () => stopped,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
it.each(['stop', 'save', 'publish', 'start', 'healthy'])(
  'resumes an interrupted %s without replacing the saved installation with promoted data',
  async (crash) => {
    const f = await fixture(crash);
    try {
      await expect(new InstallerRestorePromotion(f.root, f.adapters).run(f.job)).rejects.toThrow(
        'interrupted',
      );
      const checkpoint: { phase: string } = JSON.parse(
        await readFile(join(f.root, 'promotion'), 'utf8'),
      );
      expect(['stopping', 'saving', 'publishing', 'starting', 'checking']).toContain(
        checkpoint.phase,
      );
      await new InstallerRestorePromotion(f.root, f.adapters).run(f.job);
      expect(f.adapters.inspect).toHaveBeenCalledOnce();
      expect(f.live()).toBe('restored');
      expect(JSON.parse(await readFile(join(f.root, 'promotion'), 'utf8'))).toMatchObject({
        phase: 'healthy',
        jobId: f.job.id,
      });
      await new InstallerRestorePromotion(f.root, f.adapters).run(f.job);
      expect(f.adapters.publish).toHaveBeenCalledTimes(crash === 'publish' ? 2 : 1);
    } finally {
      await f.remove();
    }
  },
);
it('rolls back from the recorded publication phase and never guesses a new phase after interrupted rollback', async () => {
  const f = await fixture('publish');
  try {
    const promotion = new InstallerRestorePromotion(f.root, f.adapters);
    await expect(promotion.run(f.job)).rejects.toThrow('interrupted publish');
    vi.mocked(f.adapters.rollback).mockRejectedValueOnce(new Error('rollback interrupted'));
    await expect(promotion.rollback(f.job)).rejects.toThrow('rollback interrupted');
    await new InstallerRestorePromotion(f.root, f.adapters).rollback(f.job);
    expect(vi.mocked(f.adapters.rollback).mock.calls.map((call) => call[1])).toEqual([
      'publishing',
      'publishing',
    ]);
    expect(f.live()).toBe('original');
    expect(f.stopped()).toBe(false);
    await expect(promotion.run(f.job)).rejects.toThrow('cannot be resumed');
  } finally {
    await f.remove();
  }
});
