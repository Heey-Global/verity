import { createHash } from 'node:crypto';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { BackupManifest } from './format.js';
import { recoverHostKeys } from './crypto.js';
import { readBounded, readSnapshot, writeDurable } from './repository.js';
import { stageSnapshot } from './staging.js';
import { prepareRestoredGit } from './restore-git.js';
import { verifyRestoredIdentity } from './restore-identity.js';
import { assertRestorableIdentity } from './restore-identity-history.js';
import { readRevocations } from './revocations.js';
import { importDatabaseExport, type BackupDatabaseCatalog } from './database.js';
import { openBackupPath } from './git.js';
import { createRestoreDatabaseAuthority } from './restore-database-authority.js';
import { sanitizeRestoredDatabase } from './restore-database.js';
import type { RestoreJob } from './restore-job.js';

export interface RestoreStagingDependencies {
  root: string;
  liveRoot: string;
  identityHistoryRoot?: string;
  /** Uses the authenticated historical release evidence, never a moving channel. */
  checkRelease(manifest: BackupManifest, architecture: 'amd64' | 'arm64'): Promise<void>;
  /** Pull only after release verification, then inspect this exact digest's recovery capability. */
  supportsRecovery(image: string): Promise<boolean>;
  /** Reset this job's isolated DB on every retry; successful imports remain available for trial. */
  withFreshDatabase(
    job: RestoreJob,
    manifest: BackupManifest,
    bytes: bigint,
    run: (client: PoolClient) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  stageData(job: RestoreJob, tree: string, signal?: AbortSignal): Promise<void>;
  /** Stage host-only identity and host credentials, never alter the source or live host configuration. */
  stageHost(
    job: RestoreJob,
    tree: string,
    caPrivateKey: Buffer,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class InstallerRestoreStaging {
  constructor(private readonly deps: RestoreStagingDependencies) {}
  private manifest(job: RestoreJob, key: string, signal?: AbortSignal): Promise<BackupManifest> {
    return readSnapshot(
      join(job.selection.source, 'repositories'),
      job.selection.repository,
      job.selection.sequence,
      key,
      job.selection.kind,
      signal,
    );
  }
  async verify(
    job: RestoreJob,
    key: string,
    signal?: AbortSignal,
  ): Promise<NonNullable<RestoreJob['verified']>> {
    const manifest = await this.manifest(job, key, signal);
    if (!manifest.capture || typeof manifest.schema !== 'string')
      throw new Error('Snapshot does not contain a restorable installation');
    const architecture =
      process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
    if (!architecture || manifest.capture.architecture !== architecture)
      throw new Error('Snapshot has no native release for this host');
    await this.deps.checkRelease(manifest, architecture);
    signal?.throwIfAborted();
    if (!(await this.deps.supportsRecovery(manifest.capture.image)))
      throw new Error('Snapshot release does not support restricted recovery');
    const sourceInstallationId = manifest.repository.slice(
      0,
      manifest.repository.lastIndexOf('-r'),
    );
    if (manifest.capture.caKey.installationId !== sourceInstallationId)
      throw new Error('Snapshot identity belongs to another installation');
    // Read the authenticated identity in staging; no CA key is published to the destination here.
    const verificationRoot = join(this.deps.root, job.id, 'verification');
    await mkdir(verificationRoot, { recursive: true, mode: 0o700 });
    const bytes = manifest.files.reduce(
      (sum, file) =>
        sum + file.objects.reduce((total, object) => total + BigInt(object.plaintextBytes), 0n),
      0n,
    );
    const free = await statfs(verificationRoot, { bigint: true });
    if (free.bavail * free.bsize < bytes + 64n * 1024n * 1024n)
      throw new Error('Insufficient restore staging space');
    const tree = await stageSnapshot(
      verificationRoot,
      join(job.selection.source, 'repositories'),
      manifest,
      key,
      signal,
    );
    try {
      if (this.deps.identityHistoryRoot)
        await assertRestorableIdentity(
          this.deps.identityHistoryRoot,
          tree,
          job.selection.newIdentity,
        );
      const identity = await verifyRestoredIdentity(tree, key, signal);
      try {
        return {
          image: manifest.capture.image,
          manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
          schema: manifest.schema,
          architecture,
          deploymentId: identity.deploymentId,
          sourceInstallationId,
        };
      } finally {
        identity.caPrivateKey.fill(0);
      }
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  }
  async stage(job: RestoreJob, key: string, signal?: AbortSignal): Promise<void> {
    if (!job.verified) throw new Error('Restore has no verified release');
    const manifest = await this.manifest(job, key, signal);
    if (
      !manifest.capture ||
      createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !==
        job.verified.manifestHash ||
      manifest.capture.image !== job.verified.image ||
      manifest.schema !== job.verified.schema
    )
      throw new Error('Snapshot changed after verification');
    await this.deps.checkRelease(manifest, job.verified.architecture);
    const root = join(this.deps.root, job.id);
    await mkdir(root, { mode: 0o700, recursive: true });
    // This subtree is owned by the job; retries never delete live or source data.
    await rm(join(root, 'tree'), { recursive: true, force: true });
    const tree = await stageSnapshot(
      root,
      join(job.selection.source, 'repositories'),
      manifest,
      key,
      signal,
    );
    try {
      await writeDurable(join(tree, '.verity-recovery-pending'), Buffer.from(job.id), false);
      signal?.throwIfAborted();
      const warnings = await prepareRestoredGit(tree, manifest.capture, this.deps.liveRoot, signal);
      if (warnings.length) throw new Error('Restore Git verification failed');
      if (this.deps.identityHistoryRoot)
        await assertRestorableIdentity(
          this.deps.identityHistoryRoot,
          tree,
          job.selection.newIdentity,
        );
      const identity = await verifyRestoredIdentity(tree, key, signal);
      try {
        if (identity.deploymentId !== job.verified.deploymentId)
          throw new Error('Restored deployment identity changed');
        const catalog = JSON.parse(
          (await readBounded(join(tree, 'database/catalog.json'), 8 * 1024 * 1024)).toString(),
        ) as BackupDatabaseCatalog;
        const bytes = manifest.files
          .filter((file) => file.path.startsWith('database/'))
          .reduce(
            (sum, file) =>
              sum + file.objects.reduce((n, object) => n + BigInt(object.plaintextBytes), 0n),
            0n,
          );
        let imported = false;
        await this.deps.withFreshDatabase(
          job,
          manifest,
          bytes * 3n,
          async (client) => {
            if (imported) throw new Error('Restore database callback invoked twice');
            await importDatabaseExport(
              client,
              catalog,
              async function* (path) {
                const file = await openBackupPath(tree, path, false);
                try {
                  for (;;) {
                    signal?.throwIfAborted();
                    const buffer = Buffer.alloc(256 * 1024);
                    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
                    if (!bytesRead) break;
                    yield buffer.subarray(0, bytesRead);
                  }
                } finally {
                  await file.close();
                }
              },
              signal,
            );
            const devices = await client.query<{ id: string }>(
              'SELECT id FROM auth_tokens LIMIT 10001',
            );
            if (devices.rows.length > 10000) throw new Error('Restore device limit exceeded');
            const deviceIds = new Set(devices.rows.map((device) => device.id));
            const journal = await readRevocations(job.selection.source, key, signal, deviceIds);
            const reset = await sanitizeRestoredDatabase(client, {
              sourceRoot: manifest.capture!.sourceRoot,
              liveRoot: this.deps.liveRoot,
              activeTurns: manifest.capture!.activeTurns,
              revokedIds: journal.revokedIds,
              newIdentity: job.selection.newIdentity,
            });
            await createRestoreDatabaseAuthority(client, job);
            await writeDurable(
              join(root, 'devices'),
              Buffer.from(
                JSON.stringify({
                  devices: reset.devices,
                  revokedIds: [...reset.revokedIds].filter((id) => deviceIds.has(id)),
                  findings: journal.findings,
                }),
              ),
              false,
            );
            imported = true;
          },
          signal,
        );
        if (!imported) throw new Error('Restore database import did not complete');
        await this.deps.stageHost(job, tree, identity.caPrivateKey, signal);
        await this.deps.stageData(job, tree, signal);
        const keys = await recoverHostKeys(
          key,
          await readBounded(
            join(job.selection.source, 'repositories', job.selection.repository, 'keys'),
            16384,
          ),
          signal,
        );
        signal?.throwIfAborted();
        await writeDurable(join(root, 'host-keys'), Buffer.from(JSON.stringify(keys)), false);
        await rename(tree, join(root, 'tree'));
      } finally {
        identity.caPrivateKey.fill(0);
      }
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  }
}
