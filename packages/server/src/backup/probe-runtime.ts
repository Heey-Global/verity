import { mkdir, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DockerError, type DockerClient } from '../docker.js';
import { openBackupPath } from './git.js';
import type { BackupKind } from './format.js';
import type { ProbeJobDependencies, ProbeJob } from './probe-jobs.js';
import { createProbeDatabase } from './probe-database.js';
import { createProbeReleaseCheck } from './probe-release.js';
import { probeSnapshot } from './probe.js';

export interface ProbeRuntimeOptions {
  docker: DockerClient;
  network: string;
  tufCachePath: string;
}
export function probeResourcePrefix(job: Pick<ProbeJob, 'installationId' | 'id'>): string {
  z.string().uuid().parse(job.installationId);
  z.string().uuid().parse(job.id);
  return `verity-probe-${job.installationId}-${job.id}`;
}

/** Names select a candidate; readSnapshot must authenticate it, with no fallback on failure. */
export async function newestProbeSnapshot(
  root: string,
  installationId: string,
  signal?: AbortSignal,
): Promise<{ repository: string; sequence: number; kind: BackupKind }> {
  z.string().uuid().parse(installationId);
  const directory = await openBackupPath(root, 'repositories', true);
  let latest:
    | { repository: string; repositoryNumber: number; sequence: number; kind: BackupKind }
    | undefined;
  try {
    let count = 0;
    for await (const repo of await opendir(`/proc/self/fd/${directory.fd}`)) {
      signal?.throwIfAborted();
      if (++count > 10000) throw new Error('Too many backup repositories');
      if (!repo.name.startsWith(installationId + '-r')) continue;
      const match = new RegExp(`^${installationId}-r([1-9][0-9]{0,8})$`).exec(repo.name);
      if (!match || !repo.isDirectory()) throw new Error('Invalid installation repository');
      const repositoryNumber = Number(match[1]);
      const snapshots = await openBackupPath(
        `/proc/self/fd/${directory.fd}/.`,
        `${repo.name}/snapshots`,
        true,
      );
      try {
        let files = 0;
        const sequences = new Set<number>();
        for await (const snapshot of await opendir(`/proc/self/fd/${snapshots.fd}`)) {
          signal?.throwIfAborted();
          if (++files > 100000) throw new Error('Too many backup snapshots');
          if (snapshot.name.startsWith('.pending-')) continue;
          const parsed = /^([1-9][0-9]*)-(manual|scheduled|pre-update)$/.exec(snapshot.name);
          if (!parsed || !snapshot.isFile() || !Number.isSafeInteger(Number(parsed[1])))
            throw new Error('Invalid snapshot candidate');
          const sequence = Number(parsed[1]);
          if (sequences.has(sequence)) throw new Error('Duplicate snapshot sequence');
          sequences.add(sequence);
          if (
            !latest ||
            repositoryNumber > latest.repositoryNumber ||
            (repositoryNumber === latest.repositoryNumber && sequence > latest.sequence)
          )
            latest = {
              repository: repo.name,
              repositoryNumber,
              sequence,
              kind: parsed[2] as BackupKind,
            };
        }
      } finally {
        await snapshots.close();
      }
    }
  } finally {
    await directory.close();
  }
  if (!latest) throw new Error('No committed backup snapshot');
  return { repository: latest.repository, sequence: latest.sequence, kind: latest.kind };
}

export function createProbeExecution(
  options: ProbeRuntimeOptions,
  stateRoot: string,
  backupRoot: () => Promise<string>,
  architecture: 'amd64' | 'arm64',
): Pick<ProbeJobDependencies, 'execute' | 'cleanup'> {
  const staging = (job: ProbeJob) => {
    probeResourcePrefix(job);
    return join(stateRoot, 'probes', job.id);
  };
  return {
    cleanup: async (job) => {
      const prefix = probeResourcePrefix(job);
      const errors: unknown[] = [];
      for (const suffix of ['space', 'migrate', 'postgres']) {
        try {
          await options.docker.removeContainer(`${prefix}-${suffix}`);
        } catch (error) {
          if (!(error instanceof DockerError && error.kind === 'container_not_found'))
            errors.push(error);
        }
      }
      try {
        await rm(staging(job), { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new Error('Probe resources could not be removed');
    },
    execute: async (job, recoveryKey, signal, phase, selected) => {
      signal.throwIfAborted();
      const root = await backupRoot();
      const target = await newestProbeSnapshot(root, job.installationId, signal);
      await selected(target.repository, target.sequence);
      const stagingParent = staging(job);
      await mkdir(stagingParent, { recursive: true, mode: 0o700 });
      return probeSnapshot({
        ...target,
        backupRoot: root,
        recoveryKey,
        stagingParent,
        architecture,
        signal,
        phase,
        checkRelease: async (manifest, native) => {
          await createProbeReleaseCheck({
            verification: { tufCachePath: options.tufCachePath },
            signal,
          })(manifest, native);
          signal.throwIfAborted();
          const image = manifest.capture!.image;
          if (!options.docker.imageExists || !(await options.docker.imageExists(image))) {
            if (!options.docker.pullImage) throw new Error('Restore probe image pull unavailable');
            await options.docker.pullImage(image, { signal });
          }
          signal.throwIfAborted();
        },
        withDatabase: createProbeDatabase({
          docker: options.docker,
          network: options.network,
          architecture,
          signal,
          resourcePrefix: probeResourcePrefix(job),
        }),
      });
    },
  };
}
