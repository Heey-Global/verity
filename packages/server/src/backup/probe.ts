import type { PoolClient } from 'pg';
import { rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverHostKeys } from './crypto.js';
import { type BackupDatabaseCatalog, importDatabaseExport } from './database.js';
import type { BackupKind, BackupManifest } from './format.js';
import { openBackupPath } from './git.js';
import { readBounded, readSnapshot } from './repository.js';
import { prepareRestoredGit } from './restore-git.js';
import { verifyRestoredIdentity } from './restore-identity.js';
import { readRevocations } from './revocations.js';
import { stageSnapshot } from './staging.js';
import type { ProbePhase } from './probe-jobs.js';

export interface BackupProbeOptions {
  signal?: AbortSignal;
  phase?: (phase: ProbePhase) => Promise<void>;
  backupRoot: string;
  repository: string;
  sequence: number;
  kind: BackupKind;
  recoveryKey: string;
  stagingParent: string;
  architecture: 'amd64' | 'arm64';
  /** Resolve the signed image and prove native architecture/schema support before allocating staging. */
  checkRelease: (manifest: BackupManifest, architecture: 'amd64' | 'arm64') => Promise<void>;
  /** Must create a disposable DB, migrate using the pinned image, and drop it in finally. */
  withDatabase: (
    manifest: BackupManifest,
    estimatedBytes: bigint,
    run: (client: PoolClient) => Promise<void>,
  ) => Promise<void>;
}
export interface BackupProbeResult {
  repository: string;
  sequence: number;
  finishedAt: string;
  deploymentId: string;
  files: number;
  plaintextBytes: string;
  warnings: string[];
  revocationFindings: string[];
}

/** Authenticate and restore everything in disposable resources; no live state or identity writes. */
export async function probeSnapshot(options: BackupProbeOptions): Promise<BackupProbeResult> {
  options.signal?.throwIfAborted();
  const phase = async (value: ProbePhase) => {
    options.signal?.throwIfAborted();
    await options.phase?.(value);
  };
  const repositories = join(options.backupRoot, 'repositories');
  const manifest = await readSnapshot(
    repositories,
    options.repository,
    options.sequence,
    options.recoveryKey,
    options.kind,
    options.signal,
  );
  if (!manifest.capture) throw new Error('Snapshot has no recoverable installation inventory');
  await phase('release');
  await options.checkRelease(manifest, options.architecture);
  const keys = await readBounded(join(repositories, manifest.repository, 'keys'), 16384);
  await recoverHostKeys(options.recoveryKey, keys, options.signal);
  let total = 0n;
  let database = 0n;
  for (const file of manifest.files)
    for (const object of file.objects) {
      total += BigInt(object.plaintextBytes);
      if (file.path.startsWith('database/')) database += BigInt(object.plaintextBytes);
    }
  const filesystem = await statfs(options.stagingParent, { bigint: true });
  if (filesystem.bavail * filesystem.bsize < total + 64n * 1024n * 1024n)
    throw new Error('Insufficient restore probe staging space');
  await phase('staging');
  const stage = await stageSnapshot(
    options.stagingParent,
    repositories,
    manifest,
    options.recoveryKey,
    options.signal,
  );
  try {
    // The entire snapshot is extracted/authenticated even when a component is unused by this release.
    await phase('identity');
    const identity = await verifyRestoredIdentity(stage, options.recoveryKey, options.signal);
    const deploymentId = identity.deploymentId;
    identity.caPrivateKey.fill(0);
    await phase('git');
    const warnings = await prepareRestoredGit(stage, manifest.capture, stage, options.signal);
    if (warnings.length) throw new Error('Restore probe found incomplete Git history');
    const catalogFile = await openBackupPath(stage, 'database/catalog.json', false);
    let catalog: BackupDatabaseCatalog;
    try {
      const info = await catalogFile.stat();
      if (info.size > 8 * 1024 * 1024) throw new Error('Backup database catalog exceeds limit');
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await catalogFile.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new Error('Backup database catalog changed');
      catalog = JSON.parse(bytes.subarray(0, bytesRead).toString()) as BackupDatabaseCatalog;
    } finally {
      await catalogFile.close();
    }
    let imported = false;
    await phase('database');
    await options.withDatabase(manifest, database * 3n, async (client) => {
      if (imported) throw new Error('Restore probe database callback invoked twice');
      await importDatabaseExport(
        client,
        catalog,
        async function* (path) {
          const file = await openBackupPath(stage, path, false);
          try {
            // Explicit bounded reads avoid sharing a FileHandle's lifetime with
            // an autoClose:false stream while COPY waits for source completion.
            for (;;) {
              options.signal?.throwIfAborted();
              const bytes = Buffer.alloc(256 * 1024);
              const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
              if (!bytesRead) break;
              yield bytes.subarray(0, bytesRead);
            }
          } finally {
            await file.close();
          }
        },
        options.signal,
      );
      imported = true;
    });
    if (!imported) throw new Error('Restore probe database import did not complete');
    await phase('revocations');
    const journal = await readRevocations(options.backupRoot, options.recoveryKey, options.signal);
    options.signal?.throwIfAborted();
    return {
      repository: manifest.repository,
      sequence: manifest.sequence,
      finishedAt: new Date().toISOString(),
      deploymentId,
      files: manifest.files.length,
      plaintextBytes: total.toString(),
      warnings,
      revocationFindings: journal.findings,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
