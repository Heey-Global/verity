import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  InstallerRestoreJob,
  type RestoreJobAdapters,
  type RestoreSelection,
} from './restore-job.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-job-'));
  const metadata = {
    image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    schema: '0167_backup_foundation',
    architecture: 'amd64' as const,
    deploymentId: 'existing-device-identity',
    sourceInstallationId: randomUUID(),
  };
  const adapters: RestoreJobAdapters = {
    verify: vi.fn(async () => metadata),
    stage: vi.fn(async () => undefined),
    trial: vi.fn(async () => undefined),
    review: vi.fn(async () => undefined),
    promote: vi.fn(async () => undefined),
    accept: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const input: RestoreSelection = {
    source: '/copied/backup',
    repository: randomUUID() + '-r1',
    sequence: 1,
    kind: 'scheduled',
    newIdentity: false,
  };
  const manager = new InstallerRestoreJob(root, adapters);
  return {
    root,
    adapters,
    input,
    manager,
    metadata,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
it('checkpoints every transition and requires explicit calls to advance without storing secrets', async () => {
  const f = await fixture();
  try {
    const job = await f.manager.begin(f.input);
    expect(job.installationId).not.toBe(f.metadata.sourceInstallationId);
    await expect(f.manager.advance(job.id, '')).rejects.toThrow('Recovery key required');
    for (const phase of ['verified', 'staged', 'trial', 'reviewed', 'promoted', 'accepted']) {
      expect((await f.manager.advance(job.id, 'private-recovery-key')).phase).toBe(phase);
      expect((await new InstallerRestoreJob(f.root, f.adapters).status())!.phase).toBe(phase);
      expect(await readFile(join(f.root, 'job'), 'utf8')).not.toContain('private-recovery-key');
    }
    expect(f.adapters.promote).toHaveBeenCalledOnce();
    expect(f.adapters.accept).toHaveBeenCalledOnce();
    await expect(f.manager.abort(job.id)).rejects.toThrow('explicit recovery');
    await expect(f.manager.begin(f.input)).rejects.toThrow('already exists');
  } finally {
    await f.remove();
  }
});
it('retains a pending operation after failure and resumes it only on explicit retry', async () => {
  const f = await fixture();
  try {
    const job = await f.manager.begin(f.input);
    await f.manager.advance(job.id, 'secret');
    vi.mocked(f.adapters.stage).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.manager.advance(job.id, 'secret')).rejects.toThrow('disk full');
    const restarted = new InstallerRestoreJob(f.root, f.adapters);
    expect((await restarted.status())!.phase).toBe('staging');
    expect(f.adapters.stage).toHaveBeenCalledOnce();
    expect((await restarted.advance(job.id, 'secret')).phase).toBe('staged');
    expect(f.adapters.stage).toHaveBeenCalledTimes(2);
    await expect(restarted.advance(randomUUID(), 'secret')).rejects.toThrow('not found');
  } finally {
    await f.remove();
  }
});
it('serializes callers until cleanup completes and retries aborted cleanup safely', async () => {
  const f = await fixture();
  try {
    const job = await f.manager.begin(f.input);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(f.adapters.abort).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('cleanup failed');
    });
    const pending = expect(f.manager.abort(job.id)).rejects.toThrow('cleanup failed');
    await started;
    await expect(f.manager.advance(job.id, 'secret')).rejects.toThrow('locked');
    finish();
    await pending;
    expect((await f.manager.status())!.phase).toBe('aborting');
    expect((await f.manager.abort(job.id)).phase).toBe('aborted');
    await expect(f.manager.advance(job.id, 'secret')).rejects.toThrow('Aborted');
    const next = await f.manager.begin(f.input);
    expect(next.id).not.toBe(job.id);
    expect(JSON.parse(await readFile(join(f.root, 'aborted-' + job.id), 'utf8'))).toMatchObject({
      id: job.id,
      phase: 'aborted',
    });
  } finally {
    await f.remove();
  }
});
it('rejects an untrusted checkpoint and malformed or extra selection fields', async () => {
  const f = await fixture();
  try {
    await expect(f.manager.begin({ ...f.input, source: '/a/../b' })).rejects.toThrow();
    await expect(
      f.manager.begin({ ...f.input, recoveryKey: 'secret' } as RestoreSelection),
    ).rejects.toThrow();
    await writeFile(join(f.root, 'job'), '{"phase":"accepted"}');
    await expect(f.manager.status()).rejects.toThrow('Invalid restore checkpoint');
    expect(f.adapters.accept).not.toHaveBeenCalled();
  } finally {
    await f.remove();
  }
});
it('persists acceptance before backup activation and retries activation without repeating cutover', async () => {
  const f = await fixture();
  try {
    const job = await f.manager.begin(f.input);
    for (let n = 0; n < 5; n++) await f.manager.advance(job.id, 'key');
    vi.mocked(f.adapters.initialize).mockImplementationOnce(async (accepted) => {
      expect(accepted.phase).toBe('accepted');
      expect(JSON.parse(await readFile(join(f.root, 'job'), 'utf8'))).toMatchObject({
        phase: 'accepted',
      });
      throw new Error('CA helper unavailable');
    });
    await expect(f.manager.advance(job.id, 'key')).rejects.toThrow('CA helper unavailable');
    expect((await f.manager.status())!.phase).toBe('accepted');
    await expect(
      new InstallerRestoreJob(f.root, f.adapters).advance(job.id, 'key'),
    ).resolves.toMatchObject({ phase: 'accepted' });
    expect(f.adapters.promote).toHaveBeenCalledOnce();
    expect(f.adapters.accept).toHaveBeenCalledOnce();
    expect(f.adapters.initialize).toHaveBeenCalledTimes(2);
  } finally {
    await f.remove();
  }
});

it('archives an accepted restore only after its installation activation has completed', async () => {
  const f = await fixture();
  try {
    const job = await f.manager.begin(f.input);
    for (let n = 0; n < 6; n++) await f.manager.advance(job.id, 'key');
    await writeFile(join(f.root, 'activation-complete'), randomUUID());
    await expect(f.manager.begin(f.input)).rejects.toThrow('already exists');
    await writeFile(join(f.root, 'activation-complete'), job.id);
    const next = await f.manager.begin(f.input);
    expect(next.id).not.toBe(job.id);
    expect(JSON.parse(await readFile(join(f.root, 'accepted-' + job.id), 'utf8'))).toMatchObject({
      id: job.id,
      phase: 'accepted',
    });
  } finally {
    await f.remove();
  }
});

it.each(['promoted', 'accepting'] as const)(
  'allows rollback before durable acceptance from %s',
  async (phase) => {
    const f = await fixture();
    try {
      const job = await f.manager.begin(f.input);
      for (let n = 0; n < 5; n++) await f.manager.advance(job.id, 'key');
      if (phase === 'accepting') {
        vi.mocked(f.adapters.accept).mockRejectedValueOnce(new Error('authorization changed'));
        await expect(f.manager.advance(job.id, 'key')).rejects.toThrow('authorization changed');
      }
      expect((await f.manager.status())!.phase).toBe(phase);
      expect((await f.manager.abort(job.id)).phase).toBe('aborted');
      expect(f.adapters.abort).toHaveBeenCalledOnce();
    } finally {
      await f.remove();
    }
  },
);
