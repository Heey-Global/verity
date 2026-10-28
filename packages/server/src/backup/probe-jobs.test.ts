import * as repositoryIO from './repository.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  BackupProbeJobs,
  probeVerificationAlerts,
  type ProbeJobDependencies,
} from './probe-jobs.js';
import type { BackupProbeResult } from './probe.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'probe-jobs-'));
  const installationId = randomUUID();
  let work: Promise<unknown> | undefined;
  let busy = false;
  const result: BackupProbeResult = {
    repository: installationId + '-r1',
    sequence: 1,
    finishedAt: new Date().toISOString(),
    deploymentId: 'test',
    files: 1,
    plaintextBytes: '1',
    warnings: [],
    revocationFindings: [],
  };
  const execute = vi.fn<ProbeJobDependencies['execute']>(
    async (_job, _key, _signal, phase, selected) => {
      await selected(result.repository, result.sequence);
      await phase('database');
      return result;
    },
  );
  const cleanup = vi.fn<ProbeJobDependencies['cleanup']>(async () => undefined);
  const verified = vi.fn<ProbeJobDependencies['verified']>(async () => undefined);
  const deps: ProbeJobDependencies = {
    root,
    installationId,
    execute,
    cleanup,
    verified,
    exclusive: <T>(action: () => Promise<T>): Promise<T> => {
      if (busy) return Promise.reject(new Error('busy'));
      busy = true;
      const pending = Promise.resolve()
        .then(action)
        .finally(() => {
          busy = false;
        });
      work = pending;
      return pending;
    },
  };
  const manager = await BackupProbeJobs.open(deps);
  return {
    root,
    deps,
    manager,
    result,
    execute,
    cleanup,
    verified,
    idle: async () => {
      await work;
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
it('accepts a key-free durable job and commits verification only after execution and cleanup', async () => {
  const f = await fixture();
  try {
    const done = deferred();
    f.execute.mockImplementationOnce(async (job, key, signal, phase, selected) => {
      expect(key).toBe('private-recovery-key');
      expect(JSON.parse(await readFile(join(f.root, 'probe-job'), 'utf8')).id).toBe(job.id);
      await selected(f.result.repository, 1);
      await phase('staging');
      await done.promise;
      signal.throwIfAborted();
      return f.result;
    });
    const job = await f.manager.start('private-recovery-key');
    expect(job.status).toBe('running');
    expect(f.verified).not.toHaveBeenCalled();
    await expect(f.manager.start('second-private-key')).rejects.toThrow();
    done.resolve();
    await f.idle();
    expect(f.manager.status(job.id)).toMatchObject({
      status: 'succeeded',
      snapshot: { repository: f.result.repository, sequence: 1 },
    });
    expect(f.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      f.verified.mock.invocationCallOrder[0]!,
    );
    const saved = await readFile(join(f.root, 'probe-job'), 'utf8');
    expect(saved).not.toContain('private');
    expect(saved).not.toContain('recoveryKey');
    expect(f.manager.status(randomUUID())).toBeNull();
  } finally {
    await f.remove();
  }
});
it('keeps the exclusive slot while cancellation cleanup is unfinished', async () => {
  const f = await fixture();
  try {
    const cleaning = deferred();
    const enteredCleanup = deferred();
    f.execute.mockImplementationOnce(async (_job, _key, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
      signal.throwIfAborted();
      throw new Error();
    });
    f.cleanup.mockImplementationOnce(async () => {
      enteredCleanup.resolve();
      await cleaning.promise;
    });
    const job = await f.manager.start('secret');
    await f.manager.cancel(job.id);
    await enteredCleanup.promise;
    expect(f.manager.status()!.status).toBe('cancelling');
    await expect(f.manager.start('another')).rejects.toThrow();
    expect(f.verified).not.toHaveBeenCalled();
    cleaning.resolve();
    await f.idle();
    expect(f.manager.status()!.status).toBe('cancelled');
  } finally {
    await f.remove();
  }
});
it('bounds execution, reports a safe timeout and clears resources before allowing another job', async () => {
  const f = await fixture();
  try {
    const manager = await BackupProbeJobs.open({ ...f.deps, timeoutMs: 20 });
    f.execute.mockImplementationOnce(async (_job, _key, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return f.result;
    });
    await manager.start('secret');
    await f.idle();
    expect(manager.status()).toMatchObject({ status: 'failed', error: 'timed-out' });
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.verified).not.toHaveBeenCalled();
  } finally {
    await f.remove();
  }
});
it('never verifies a failed probe or failed cleanup and never persists secret exception messages', async () => {
  const f = await fixture();
  try {
    f.execute.mockRejectedValueOnce(new Error('private-key-in-error'));
    await f.manager.start('private-key');
    await f.idle();
    expect(f.manager.status()).toMatchObject({ status: 'failed', error: 'probe-failed' });
    f.cleanup
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('private-cleanup-error'));
    await f.manager.start('private-key');
    await f.idle();
    expect(f.manager.status()).toMatchObject({ status: 'failed', error: 'cleanup-failed' });
    expect(f.verified).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, 'probe-job'), 'utf8')).not.toContain('private');
    f.cleanup.mockRejectedValueOnce(new Error('still cannot clean up'));
    await expect(f.manager.start('secret')).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(2);
  } finally {
    await f.remove();
  }
});
it('marks a crashed job interrupted after cleanup without reusing a key or executing work', async () => {
  const f = await fixture();
  try {
    const record = {
      format: 1,
      installationId: f.deps.installationId,
      id: randomUUID(),
      status: 'running',
      phase: 'database',
      startedAt: 1,
      finishedAt: null,
      snapshot: null,
      error: null,
    };
    await writeFile(join(f.root, 'probe-job'), JSON.stringify(record));
    const manager = await BackupProbeJobs.open(f.deps);
    expect(manager.status()).toMatchObject({
      id: record.id,
      status: 'interrupted',
      error: 'interrupted',
    });
    expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(record);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.verified).not.toHaveBeenCalled();
    await writeFile(
      join(f.root, 'probe-job'),
      JSON.stringify({ ...record, installationId: randomUUID() }),
    );
    await expect(BackupProbeJobs.open(f.deps)).rejects.toThrow('Foreign');
    expect(f.cleanup).toHaveBeenCalledOnce();
  } finally {
    await f.remove();
  }
});
it('refuses startup when interrupted-job cleanup fails and aborts active work on shutdown', async () => {
  const f = await fixture();
  try {
    f.execute.mockImplementationOnce(async (_job, _key, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
      signal.throwIfAborted();
      return f.result;
    });
    await f.manager.start('secret');
    f.manager.abort();
    await f.idle();
    expect(f.manager.status()!.status).toBe('cancelled');
    f.cleanup.mockRejectedValueOnce(new Error('cannot remove worker'));
    await expect(BackupProbeJobs.open(f.deps)).rejects.toThrow('cannot remove worker');
  } finally {
    await f.remove();
  }
});

it('keeps last verification independent of failures and reminds only after ninety days', () => {
  const day = 24 * 60 * 60 * 1000;
  expect(probeVerificationAlerts(100, null, 100 + 89 * day)).toEqual([]);
  expect(probeVerificationAlerts(100, null, 100 + 90 * day)).toEqual(['probe-overdue']);
  expect(probeVerificationAlerts(0, { finishedAt: 100 }, 100 + 90 * day)).toEqual([
    'probe-overdue',
  ]);
  expect(probeVerificationAlerts(0, { finishedAt: 100 + 89 * day }, 100 + 90 * day)).toEqual([]);
});

it('still cleans up and refuses verification when saving the cleanup phase fails', async () => {
  const f = await fixture();
  const finish = deferred();
  try {
    f.execute.mockImplementationOnce(async () => {
      await finish.promise;
      return f.result;
    });
    await f.manager.start('secret');
    const write = vi
      .spyOn(repositoryIO, 'writeDurable')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      finish.resolve();
      await f.idle();
    } finally {
      write.mockRestore();
    }
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.verified).not.toHaveBeenCalled();
    expect(f.manager.status()!.status).toBe('failed');
  } finally {
    await f.remove();
  }
});
