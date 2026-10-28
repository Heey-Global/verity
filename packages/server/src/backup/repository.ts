import { openBackupDirectory } from './directory.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { backupWork } from './priority.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rm, opendir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { BackupFileChangedError } from './capture-errors.js';
import { chunkContent } from './chunking.js';
import {
  decryptStream,
  encryptStream,
  openMetadata,
  sealMetadata,
  sealHostKeyBundle,
  verifyMetadata,
  type BackupHostKeys,
} from './crypto.js';
import {
  parseManifest,
  validateBackupPath,
  validateRepositoryName,
  type BackupKind,
  type BackupFile,
  type BackupManifest,
  type BackupObject,
} from './format.js';
import { withRepositoryLock } from './repository-lock.js';

import { encodeLocalIndex, decodeLocalIndex, encodeBoundedLocalIndex } from './local-state.js';
import type { CaptureMetadata } from './capture-metadata.js';
import type { BackupDestination } from './destination.js';
import { GC_GRACE_MS, retainedSnapshots } from './retention.js';

interface RepositoryState {
  next: number;
  index: Record<string, BackupObject>;
}
export interface CaptureFile {
  kind?: 'file';
  path: string;
  mode: number;
  source: AsyncIterable<Uint8Array> | ((attempt: number) => AsyncIterable<Uint8Array>);
  unstable?: () => boolean;
  sizeBytes?: bigint;
}

export type CaptureEntry =
  | CaptureFile
  | { kind: 'directory'; path: string; mode: number }
  | { kind: 'symlink'; path: string; target: string };

async function syncDirectory(path: string): Promise<void> {
  // A held directory FD is an intentional procfs capability, not a user-supplied symlink.
  // Keep it an intermediate component so O_NOFOLLOW still protects the final directory.
  const target = /^\/proc\/self\/fd\/[0-9]+$/.test(path) ? path + '/.' : path;
  const directory = await open(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
/** Private temp file, durable contents, then atomic publication and durable directory entry. */
export async function writeDurable(
  path: string,
  bytes: Uint8Array,
  immutable: boolean,
): Promise<void> {
  const work = backupWork();
  if (work) {
    await work.call('write', bytes, { path, immutable });
    return;
  }
  const temporary = join(dirname(path), `.pending-${randomBytes(16).toString('hex')}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (immutable) await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid backup file size or type');
    // Bound the actual read even if another writer extends the file after stat.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Backup file changed while reading');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Low-level format writer; not exposed by routes until the full recovery acceptance gate passes. */
export class BackupRepository {
  private readonly repositoryRoot: string;
  private readonly pinnedRoot = new AsyncLocalStorage<string>();
  get root(): string {
    return this.pinnedRoot.getStore() ?? this.repositoryRoot;
  }
  readonly stateRoot: string;
  readonly name: string;
  readonly host: BackupHostKeys;
  constructor(
    root: string,
    stateRoot: string,
    name: string,
    host: BackupHostKeys,
    private readonly destination?: BackupDestination,
  ) {
    validateRepositoryName(name);
    if (destination && resolve(root) !== resolve(destination.path))
      throw new Error('Backup destination path mismatch');
    this.repositoryRoot = destination ? destination.repositoryPath(name) : join(root, name);
    this.stateRoot = join(stateRoot, name);
    this.name = name;
    this.host = host;
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const parent = this.destination
      ? await openBackupDirectory(this.destination.pinnedPath('repositories'))
      : undefined;
    try {
      const directory = await openBackupDirectory(
        parent ? `/proc/${process.pid}/fd/${parent.fd}/${this.name}` : this.repositoryRoot,
      );
      try {
        return await this.pinnedRoot.run(`/proc/${process.pid}/fd/${directory.fd}/.`, () =>
          withRepositoryLock(join(this.root, 'lock'), action),
        );
      } finally {
        await directory.close();
      }
    } finally {
      await parent?.close();
    }
  }
  private async write(path: string, bytes: Uint8Array, immutable: boolean): Promise<void> {
    await this.destination?.assertWritable(BigInt(bytes.length));
    await writeDurable(path, bytes, immutable);
  }

  async initialize(): Promise<void> {
    await this.destination?.assertWritable();
    if (this.destination) {
      const path = this.destination.pinnedPath('repositories');
      await mkdir(path, { recursive: true, mode: 0o700 });
      const parent = await openBackupDirectory(path);
      try {
        await mkdir(`/proc/self/fd/${parent.fd}/${this.name}`, { recursive: true, mode: 0o700 });
      } finally {
        await parent.close();
      }
    } else await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await this.withLock(async () => {
      await mkdir(join(this.root, 'objects'), { mode: 0o700 });
      await mkdir(join(this.root, 'snapshots'), { mode: 0o700 });
      await mkdir(join(this.stateRoot, 'references'), { mode: 0o700 });
      await this.write(
        join(this.root, 'header'),
        await sealMetadata(
          this.host,
          Buffer.from(
            JSON.stringify({
              kind: 'repository',
              format: 1,
              repository: this.name,
              createdAt: new Date().toISOString(),
            }),
          ),
        ),
        true,
      );
      await this.write(join(this.root, 'keys'), await sealHostKeyBundle(this.host), true);
      await this.write(join(this.root, 'sequence'), Buffer.from('0'), true);
      await this.write(
        join(this.stateRoot, 'index'),
        encodeLocalIndex({}, this.host.fingerprintKey),
        true,
      );
    });
  }

  async capture(
    files: AsyncIterable<CaptureEntry>,
    info: { release: string; schema: string | number; capturedAt: string; kind?: BackupKind },
    finalizeMetadata?: () => CaptureMetadata,
  ): Promise<BackupManifest> {
    return this.withLock(async () => {
      const state = await this.readState();
      const manifest: BackupManifest = {
        format: 1,
        repository: this.name,
        sequence: state.next,
        ...info,
        kind: info.kind ?? 'manual',
        files: [],
        directories: [],
        symlinks: [],
      };
      // Reserve monotonically even when this run fails or a snapshot is later deleted.
      await this.write(join(this.root, 'sequence'), Buffer.from(String(state.next)), false);
      let metadataBytes = 1024;
      for await (const file of files) {
        metadataBytes += Buffer.byteLength(file.path) + 128;
        if (metadataBytes > 7 * 1024 * 1024) throw new Error('Backup metadata exceeds limit');
        validateBackupPath(file.path);
        if (file.kind === 'directory') {
          manifest.directories!.push({ path: file.path, mode: file.mode });
          continue;
        }
        if (file.kind === 'symlink') {
          metadataBytes += Buffer.byteLength(file.target);
          manifest.symlinks!.push({ path: file.path, target: file.target });
          continue;
        }
        const entry: BackupFile = { path: file.path, mode: file.mode, objects: [] };
        for (let attempt = 0; attempt < 3; attempt++) {
          entry.objects = [];
          try {
            for await (const chunk of chunkContent(
              typeof file.source === 'function' ? file.source(attempt) : file.source,
            )) {
              const work = backupWork();
              const fingerprint = work
                ? ((await work.call('fingerprint', chunk, {
                    key: this.host.fingerprintKey,
                  })) as string)
                : createHmac('sha256', Buffer.from(this.host.fingerprintKey, 'base64url'))
                    .update(chunk)
                    .digest('hex');
              let object = state.index[fingerprint];
              if (object && !(await this.objectValid(object))) object = undefined;
              if (!object) {
                const ciphertext = work
                  ? Buffer.from(
                      (await work.call('encrypt', chunk, {
                        key: this.host.recipient,
                      })) as Uint8Array,
                    )
                  : Buffer.from(
                      await new Response(
                        await encryptStream(
                          this.host.recipient,
                          Readable.toWeb(Readable.from([chunk])) as ReadableStream<Uint8Array>,
                        ),
                      ).arrayBuffer(),
                    );
                object = {
                  id: randomBytes(32).toString('hex'),
                  digest: digest(ciphertext),
                  ciphertextBytes: ciphertext.length,
                  plaintextBytes: chunk.length,
                };
                await this.write(join(this.root, 'objects', object.id), ciphertext, true);
                state.index[fingerprint] = object;
                // Preserve completed work when capture is interrupted before a manifest exists.
                await this.write(
                  join(this.stateRoot, 'index'),
                  encodeBoundedLocalIndex(state.index, this.host.fingerprintKey),
                  false,
                );
              }
              metadataBytes += 256;
              if (metadataBytes > 7 * 1024 * 1024) throw new Error('Backup metadata exceeds limit');
              entry.objects.push(object);
              if (entry.objects.length > 100000)
                throw new Error('Backup file object count exceeds limit');
            }
            break;
          } catch (error) {
            if (
              !(error instanceof BackupFileChangedError) ||
              typeof file.source !== 'function' ||
              attempt === 2
            )
              throw error;
          }
        }
        if (file.unstable?.()) entry.unstable = true;
        manifest.files.push(entry);
        if (manifest.files.length > 50000) throw new Error('Backup path count exceeds limit');
      }
      if (finalizeMetadata) manifest.capture = finalizeMetadata();
      // Validate our own output against the same bounds as restore before publication.
      const plaintext = Buffer.from(JSON.stringify(manifest));
      parseManifest(plaintext, this.name, manifest.sequence);
      for (const object of manifest.files.flatMap((file) => file.objects)) {
        if (!(await this.objectValid(object)))
          throw new Error('Backup object unavailable before publication');
      }
      await this.write(
        join(this.stateRoot, 'index'),
        encodeBoundedLocalIndex(state.index, this.host.fingerprintKey),
        false,
      );
      const sealed = await sealMetadata(this.host, plaintext);
      await this.write(
        join(this.stateRoot, 'references', String(manifest.sequence)),
        encodeLocalIndex(
          {
            repository: this.name,
            kind: manifest.kind,
            digest: digest(sealed),
            preUpdate: manifest.kind === 'pre-update',
            capturedAt: manifest.capturedAt,
            sequence: manifest.sequence,
            objects: [
              ...new Set(manifest.files.flatMap((file) => file.objects.map((object) => object.id))),
            ],
          },
          this.host.fingerprintKey,
        ),
        true,
      );
      await this.write(
        join(this.root, 'snapshots', `${manifest.sequence}-${manifest.kind}`),
        sealed,
        true,
      );
      return manifest;
    });
  }

  /** Exclusive with capture and extraction. Missing host references stop ALL pruning and GC. */
  async maintain(options: {
    installationId: string;
    now: number;
    paused: boolean;
    retained?: ReadonlySet<string>;
    catalogued?: ReadonlySet<string>;
    emptyRetired?: boolean;
    shouldPrune?: () => Promise<boolean>;
  }): Promise<{ snapshots: number; objects: number }> {
    if (this.name.slice(0, this.name.lastIndexOf('-')) !== options.installationId)
      throw new Error('Cannot prune another installation repository');
    if (options.paused) return { snapshots: 0, objects: 0 };
    if (!Number.isFinite(options.now)) throw new Error('Invalid backup maintenance time');
    return this.withLock(async () => {
      await this.destination?.assertPresent();
      const references = await this.maintenanceReferences();
      const repositoryNumber = Number(this.name.slice(this.name.lastIndexOf('r') + 1));
      const retained =
        options.retained ??
        retainedSnapshots(
          [...references].map(([sequence, reference]) => ({
            repositoryNumber,
            sequence,
            capturedAt: reference.capturedAt,
            preUpdate: reference.preUpdate,
          })),
          options.now,
        );
      const reachable = new Set<string>();
      let removedSnapshots = 0;
      for (const [sequence, reference] of references) {
        const key = `${repositoryNumber}/${sequence}`;
        if (retained.has(key) || (options.catalogued && !options.catalogued.has(key))) {
          for (const id of reference.objects) reachable.add(id);
        } else {
          await this.destination?.assertPresent();
          if (options.shouldPrune && !(await options.shouldPrune()))
            return { snapshots: removedSnapshots, objects: 0 };
          await rm(join(this.root, 'snapshots', reference.filename));
          await syncDirectory(join(this.root, 'snapshots'));
          await rm(join(this.stateRoot, 'references', String(sequence)));
          removedSnapshots++;
        }
      }
      // An empty/missing catalog is never enough evidence to delete a repository's objects.
      if (!references.size && !options.emptyRetired)
        return { snapshots: removedSnapshots, objects: 0 };
      if (!references.size)
        verifyMetadata(
          this.host.verificationKey,
          await readBounded(join(this.root, 'header'), 65536),
        );
      // Persist cache pruning before deletion so an interrupted GC cannot strand stale entries.
      const state = await this.readState();
      for (const [fingerprint, object] of Object.entries(state.index))
        if (!reachable.has(object.id)) delete state.index[fingerprint];
      await writeDurable(
        join(this.stateRoot, 'index'),
        encodeBoundedLocalIndex(state.index, this.host.fingerprintKey),
        false,
      );
      let removedObjects = 0;
      for (const id of await boundedDirectory(join(this.root, 'objects'), 200000)) {
        if (!/^[0-9a-f]{64}$/.test(id)) continue; // Publication temporaries are not committed objects.
        if (reachable.has(id)) continue;
        const path = join(this.root, 'objects', id);
        const info = await lstat(path);
        if (!info.isFile()) throw new Error('Unexpected backup object type');
        if (info.mtimeMs > options.now - GC_GRACE_MS) continue;
        await this.destination?.assertPresent();
        if (options.shouldPrune && !(await options.shouldPrune()))
          return { snapshots: removedSnapshots, objects: removedObjects };
        await rm(path);
        removedObjects++;
      }
      await syncDirectory(join(this.root, 'objects'));
      return { snapshots: removedSnapshots, objects: removedObjects };
    });
  }

  /** Authenticated local reference catalog; missing references fail closed before any deletion. */
  async retentionCatalog(): Promise<import('./retention.js').RetentionSnapshot[]> {
    return this.withLock(async () => {
      await this.destination?.assertPresent();
      const references = await this.maintenanceReferences();
      const repositoryNumber = Number(this.name.slice(this.name.lastIndexOf('r') + 1));
      return [...references].map(([sequence, value]) => ({
        repositoryNumber,
        sequence,
        capturedAt: value.capturedAt,
        preUpdate: value.preUpdate,
      }));
    });
  }
  private async maintenanceReferences() {
    const references = new Map<
      number,
      { filename: string; capturedAt: string; preUpdate: boolean; objects: string[] }
    >();
    const snapshots = await boundedDirectory(join(this.root, 'snapshots'), 50000);
    let referenceBytes = 0;
    let referenceCount = 0;
    for (const name of snapshots) {
      const match = /^([1-9][0-9]*)-(manual|scheduled|pre-update)$/.exec(name);
      if (!match || !Number.isSafeInteger(Number(match[1])))
        throw new Error('Unexpected backup snapshot entry');
      const sequence = Number(match[1]);
      if (references.has(sequence)) throw new Error('Duplicate backup snapshot sequence');
      const sealed = await readBounded(join(this.root, 'snapshots', name), 9 * 1024 * 1024);
      verifyMetadata(this.host.verificationKey, sealed);
      const referenceData = await readBounded(
        join(this.stateRoot, 'references', String(sequence)),
        16 * 1024 * 1024,
      );
      referenceBytes += referenceData.length;
      if (referenceBytes > 32 * 1024 * 1024)
        throw new Error('Backup maintenance reference budget exceeded');
      const raw = decodeLocalIndex(referenceData, this.host.fingerprintKey);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Missing backup references');
      const reference = raw as Record<string, unknown>;
      if (
        reference['repository'] !== this.name ||
        reference['sequence'] !== sequence ||
        reference['kind'] !== match[2] ||
        reference['digest'] !== digest(sealed) ||
        typeof reference['capturedAt'] !== 'string' ||
        !Number.isFinite(Date.parse(reference['capturedAt'])) ||
        typeof reference['preUpdate'] !== 'boolean' ||
        !Array.isArray(reference['objects']) ||
        reference['objects'].length > 200000 ||
        !reference['objects'].every(
          (id: unknown) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id),
        )
      )
        throw new Error('Invalid backup references; maintenance refused');
      referenceCount += reference['objects'].length;
      if (referenceCount > 200000) throw new Error('Backup maintenance reference count exceeded');
      references.set(sequence, {
        filename: name,
        capturedAt: reference['capturedAt'],
        preUpdate: reference['preUpdate'],
        objects: reference['objects'] as string[],
      });
    }
    return references;
  }

  private async readState(): Promise<RepositoryState> {
    const sequence = (await readBounded(join(this.root, 'sequence'), 32)).toString();
    if (!/^(0|[1-9][0-9]*)$/.test(sequence) || !Number.isSafeInteger(Number(sequence) + 1))
      throw new Error('Invalid backup sequence');
    const value: unknown = decodeLocalIndex(
      await readBounded(join(this.stateRoot, 'index'), 32 * 1024 * 1024),
      this.host.fingerprintKey,
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Missing backup index: start a new repository');
    const index = value as Record<string, BackupObject>;
    // The cache is untrusted; only syntactically valid bounded object references may reach the filesystem.
    for (const [fingerprint, object] of Object.entries(index)) {
      if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Invalid backup index');
      parseManifest(
        Buffer.from(
          JSON.stringify({
            format: 1,
            repository: this.name,
            sequence: 1,
            capturedAt: new Date(0).toISOString(),
            release: 'index-validation',
            schema: 0,
            files: [{ path: 'index', mode: 0o600, objects: [object] }],
          }),
        ),
        this.name,
        1,
      );
    }
    return { next: Number(sequence) + 1, index };
  }

  private async objectValid(object: BackupObject): Promise<boolean> {
    try {
      const bytes = await readBounded(join(this.root, 'objects', object.id), 2 * 1024 * 1024);
      return bytes.length === object.ciphertextBytes && digest(bytes) === object.digest;
    } catch {
      return false;
    }
  }
}

async function boundedDirectory(path: string, maximum: number): Promise<string[]> {
  const names: string[] = [];
  const entries = await opendir(path);
  for await (const entry of entries) {
    if (names.length === maximum) throw new Error('Backup directory entry count exceeds limit');
    names.push(entry.name);
  }
  return names;
}

export async function readRepositoryHeader(
  root: string,
  name: string,
  recoveryKey: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  validateRepositoryName(name);
  const value: unknown = JSON.parse(
    (
      await openMetadata(recoveryKey, await readBounded(join(root, name, 'header'), 8192), signal)
    ).toString(),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid backup repository header');
  const header = value as Record<string, unknown>;
  if (
    header['kind'] !== 'repository' ||
    header['format'] !== 1 ||
    header['repository'] !== name ||
    typeof header['createdAt'] !== 'string' ||
    !Number.isFinite(Date.parse(header['createdAt']))
  )
    throw new Error('Backup repository header mismatch');
}

/** No index, host state, or earlier snapshot participates in restore authority. */
export async function readSnapshot(
  root: string,
  name: string,
  sequence: number,
  recoveryKey: string,
  kind: BackupKind = 'manual',
  signal?: AbortSignal,
): Promise<BackupManifest> {
  validateRepositoryName(name);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid snapshot sequence');
  if (!['manual', 'scheduled', 'pre-update'].includes(kind)) throw new Error('Invalid backup kind');
  await readRepositoryHeader(root, name, recoveryKey, signal);
  const sealed = await readBounded(
    join(root, name, 'snapshots', `${sequence}-${kind}`),
    9 * 1024 * 1024,
  );
  const manifest = parseManifest(await openMetadata(recoveryKey, sealed, signal), name, sequence);
  if (manifest.kind !== kind) throw new Error('Backup snapshot kind mismatch');
  return manifest;
}

/** Yields authenticated, complete chunks only; caller writes to private staging and promotes after all files pass. */
export async function* restoreFile(
  root: string,
  manifest: BackupManifest,
  file: BackupFile,
  recoveryKey: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  validateRepositoryName(manifest.repository);
  for (const object of file.objects) {
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{64}$/.test(object.id)) throw new Error('Invalid backup object');
    const ciphertext = await readBounded(
      join(root, manifest.repository, 'objects', object.id),
      2 * 1024 * 1024,
    );
    if (ciphertext.length !== object.ciphertextBytes || digest(ciphertext) !== object.digest)
      throw new Error('Backup object integrity mismatch');
    const plaintext = Buffer.from(
      await new Response(
        await decryptStream(
          recoveryKey,
          Readable.toWeb(Readable.from([ciphertext])) as ReadableStream<Uint8Array>,
          signal,
        ),
      ).arrayBuffer(),
    );
    if (plaintext.length !== object.plaintextBytes)
      throw new Error('Backup object length mismatch');
    yield plaintext;
  }
}
