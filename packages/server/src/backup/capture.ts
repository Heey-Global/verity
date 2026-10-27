import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beginDatabaseExport } from './database.js';
import { captureTree } from './filesystem.js';
import { freezeGitDirectory, type FrozenGit } from './git.js';
import { BackupLifecycleCoordinator } from './lifecycle.js';
import { type BackupRepository, type CaptureEntry } from './repository.js';
import { type BackupKind, type BackupManifest } from './format.js';
import { type CaptureMetadata, captureMetadataSchema } from './capture-metadata.js';
import type { BackupDestination } from './destination.js';
import { withRepositoryLock } from './repository-lock.js';
import { openCaIdentityReceipt } from './identity-receipt.js';
import { validateReadableIdentity } from './restore-identity.js';

export const IDENTITY_FILES = [
  'deployment-id',
  'pairing-identity.pem',
  'tls-key.pem',
  'tls-cert.pem',
  'tls-ca-cert.pem',
] as const;
const DATA_SCOPES = ['workspaces', 'sessions', 'knowledge'] as const;
export interface CaptureInventory {
  projects: Omit<CaptureMetadata['projects'][number], 'bytes'>[];
  activeTurns: string[];
}
export interface CompleteCaptureOptions {
  root: string;
  identityRoot: string;
  caCiphertext: string;
  installationId: string;
  keyGeneration: number;
  image: string;
  release: string;
  schema: string;
  architecture: 'amd64' | 'arm64';
  kind: BackupKind;
  connect: () => Promise<PoolClient>;
  repository: BackupRepository;
  lifecycle: BackupLifecycleCoordinator;
  destination: BackupDestination;
  /** Read through this same dedicated snapshot client before opening a COPY stream. */
  inventory: (client: PoolClient) => Promise<CaptureInventory>;
  /** Persisted project bookkeeping; never trust a sandbox marker or inode as identity. */
  repoKey: (projectId: string, path: string) => Promise<string>;
  signal: AbortSignal;
}

async function bytesAt(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > maximum) throw new Error('Invalid backup identity file');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(size) !== before.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Identity changed during capture');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

/** One DB snapshot, short Git barrier, and project copy leases lasting through immutable publication. */
export async function captureInstallation(
  options: CompleteCaptureOptions,
): Promise<BackupManifest> {
  options.signal.throwIfAborted();
  const stagingParent = join(options.root, 'capture');
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(join(stagingParent, 'run-'));
  try {
    return await withRepositoryLock(join(run, 'lock'), () => captureInRun(options, run));
  } finally {
    await rm(run, { recursive: true, force: true });
  }
}

async function captureInRun(options: CompleteCaptureOptions, run: string): Promise<BackupManifest> {
  const { signal, lifecycle } = options;
  signal.throwIfAborted();
  await options.destination.assertWritable();
  const startedAt = new Date().toISOString();
  const barrierStarted = performance.now();
  let database: Awaited<ReturnType<typeof beginDatabaseExport>> | undefined;
  let release: (() => void) | undefined;
  const frozen: { path: string; projectId: string; repoKey: string; copy: FrozenGit }[] = [];
  const metadata: CaptureMetadata = {
    startedAt,
    finishedAt: startedAt,
    databaseAt: startedAt,
    barrierMs: 0,
    sourceRoot: options.root,
    architecture: options.architecture,
    image: options.image,
    scope: ['database', ...DATA_SCOPES, 'identity'],
    activeTurns: [],
    projects: [],
    exclusions: [],
    warnings: [],
    identity: [...IDENTITY_FILES],
    caKey: {
      installationId: options.installationId,
      keyGeneration: options.keyGeneration,
      path: 'identity/ca-key.age',
    },
    git: [],
  };
  const abort = (): void => {
    void database?.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const lease = await lifecycle.beginCapture(async () => {
      signal.throwIfAborted();
      const client = await options.connect();
      database = await beginDatabaseExport(client);
      metadata.databaseAt = database.catalog.capturedAt;
      const inventory = await options.inventory(client);
      metadata.projects = inventory.projects.map((project) => ({
        ...project,
        bytes: '0',
        warnings: [
          ...project.warnings,
          'Writable container layers, in-container services, external custom mounts and agent gateway sign-ins are not included.',
        ],
      }));
      metadata.activeTurns = inventory.activeTurns;
      const discoveries: { path: string; kind: 'directory' | 'file' | 'symlink' }[] = [];
      let estimate = 0n;
      const databaseSize = await client.query<{ bytes: string }>(
        'SELECT pg_database_size(current_database())::text AS bytes',
      );
      estimate += BigInt(databaseSize.rows[0]!.bytes);
      for (const scope of DATA_SCOPES) {
        for await (const entry of captureTree(join(options.root, scope), {
          prefix: scope,
          excludeRegenerable: true,
          onExcluded: () => undefined,
          onGit: (path, kind) => discoveries.push({ path, kind }),
        })) {
          signal.throwIfAborted();
          if (entry.kind !== 'directory' && entry.kind !== 'symlink')
            estimate += entry.sizeBytes ?? 0n;
        }
      }
      for (const discovery of discoveries) {
        signal.throwIfAborted();
        if (discovery.kind === 'file') continue; // Restored pointers are checked again before any Git command.
        const project = metadata.projects.find((candidate) =>
          candidate.paths.some((path) => discovery.path.startsWith(path + '/')),
        );
        if (!project) {
          throw new Error('Git directory has no captured project ownership');
        }
        const repoKey = await options.repoKey(project.id, discovery.path);
        if (discovery.kind === 'symlink') {
          metadata.git.push({
            repoKey,
            projectId: project.id,
            path: discovery.path,
            status: 'not-validated',
            findings: ['symlink:.git omitted'],
            pointers: [],
          });
          continue;
        }
        const copy = await freezeGitDirectory(options.root, discovery.path, run, project.paths);
        for await (const entry of captureTree(copy.directory, {
          prefix: 'estimate',
          excludeRegenerable: false,
          onExcluded: () => undefined,
        }))
          if (entry.kind !== 'directory' && entry.kind !== 'symlink')
            estimate += entry.sizeBytes ?? 0n;
        frozen.push({ path: discovery.path, projectId: project.id, repoKey, copy });
      }
      await options.destination.assertWritable(estimate);
      metadata.barrierMs = performance.now() - barrierStarted;
      return { projectIds: metadata.projects.map((project) => project.id), value: undefined };
    });
    release = lease.release;
    for (const git of frozen) {
      for (let attempt = 1; git.copy.status === 'unstable' && attempt < 3; attempt++) {
        signal.throwIfAborted();
        const old = git.copy;
        git.copy = await lifecycle.refreeze(() =>
          freezeGitDirectory(
            options.root,
            git.path,
            run,
            metadata.projects.find((project) => project.id === git.projectId)!.paths,
          ),
        );
        await rm(old.directory, { recursive: true, force: true });
      }
      metadata.git.push({
        repoKey: git.repoKey,
        projectId: git.projectId,
        path: git.path,
        status: git.copy.status,
        findings: git.copy.findings,
        pointers: git.copy.pointers,
      });
    }
    const onExcluded = (path: string, bytes: bigint): void => {
      if (metadata.exclusions.length >= 50000)
        throw new Error('Backup exclusion count exceeds limit');
      metadata.exclusions.push({ path, bytes: String(bytes) });
    };
    async function* entries(): AsyncGenerator<CaptureEntry> {
      yield* database!.files;
      // COPY is fully consumed before opening live file sources; all project leases remain held.
      for (const scope of DATA_SCOPES)
        yield* captureTree(join(options.root, scope), {
          prefix: scope,
          excludeRegenerable: true,
          onExcluded,
          onGit: () => undefined,
        });
      for (const git of frozen) {
        yield* captureTree(git.copy.git, {
          prefix: `git/${git.repoKey}/git`,
          excludeRegenerable: false,
          onExcluded,
        });
        yield* captureTree(git.copy.userFiles, {
          prefix: `git/${git.repoKey}/user-files`,
          excludeRegenerable: false,
          onExcluded,
        });
      }
      const identity = new Map<string, Buffer>();
      for (const name of IDENTITY_FILES)
        identity.set(name, await bytesAt(join(options.identityRoot, name), 1024 * 1024));
      validateReadableIdentity(identity);
      const encryptedCa = openCaIdentityReceipt(
        await bytesAt(options.caCiphertext, 384 * 1024),
        identity.get('tls-ca-cert.pem')!,
        options.installationId,
        options.keyGeneration,
        options.repository.host.recipient,
      );
      for (const [name, bytes] of identity) {
        yield { path: `identity/${name}`, mode: 0o600, source: Readable.from([bytes]) };
      }
      yield {
        path: 'identity/ca-key.age',
        mode: 0o600,
        source: Readable.from([encryptedCa]),
      };
    }
    async function* measured(): AsyncGenerator<CaptureEntry> {
      for await (const entry of entries()) {
        signal.throwIfAborted();
        if (entry.kind === 'directory' || entry.kind === 'symlink') {
          yield entry;
          continue;
        }
        let size = 0n;
        const source = entry.source;
        const project =
          metadata.projects.find((candidate) =>
            candidate.paths.some((path) => entry.path.startsWith(path + '/')),
          ) ??
          metadata.projects.find((candidate) =>
            frozen.some(
              (git) =>
                git.projectId === candidate.id && entry.path.startsWith(`git/${git.repoKey}/`),
            ),
          );
        yield {
          ...entry,
          source: async function* (attempt: number) {
            size = 0n;
            for await (const bytes of typeof source === 'function' ? source(attempt) : source) {
              signal.throwIfAborted();
              size += BigInt(bytes.byteLength);
              yield bytes;
            }
          },
        };
        if (project) project.bytes = String(BigInt(project.bytes) + size);
      }
    }
    return await options.repository.capture(
      measured(),
      {
        release: options.release,
        schema: options.schema,
        capturedAt: metadata.databaseAt,
        kind: options.kind,
      },
      () => {
        signal.throwIfAborted();
        metadata.finishedAt = new Date().toISOString();
        for (const project of metadata.projects)
          if (BigInt(project.bytes) > 2n * 1024n ** 3n)
            project.warnings.push('Captured project data exceeds 2 GB.');
        return captureMetadataSchema.parse(metadata);
      },
    );
  } finally {
    signal.removeEventListener('abort', abort);
    await database?.close();
    release?.();
  }
}
