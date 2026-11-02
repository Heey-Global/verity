import { posix } from 'node:path';
import { captureMetadataSchema, type CaptureMetadata } from './capture-metadata.js';

const BACKUP_FORMAT_VERSION = 1;
const MAX_MANIFEST_ENTRIES = 50000;
const MAX_OBJECTS_PER_FILE = 100000;
export interface BackupObject {
  id: string;
  digest: string;
  ciphertextBytes: number;
  plaintextBytes: number;
}
export interface BackupFile {
  path: string;
  mode: number;
  objects: BackupObject[];
  unstable?: boolean;
}
export type BackupKind = 'manual' | 'scheduled' | 'pre-update';
export interface BackupManifest {
  format: 1;
  repository: string;
  sequence: number;
  capturedAt: string;
  release: string;
  schema: string | number;
  capture?: CaptureMetadata;
  kind?: BackupKind;
  files: BackupFile[];
  directories?: { path: string; mode: number }[];
  symlinks?: { path: string; target: string }[];
}

export function validateRepositoryName(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-r[1-9][0-9]{0,8}$/.test(value)
  )
    throw new Error('Invalid backup repository');
}
export function validateBackupPath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\\') ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    posix.isAbsolute(value) ||
    value !== posix.normalize(value) ||
    value.split('/').some((p) => p === '..' || p === '.' || p === '')
  ) {
    throw new Error('Unsafe backup path');
  }
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid backup manifest');
  return value as Record<string, unknown>;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Only call after signature verification; all data still receives bounded structural validation. */
export function parseManifest(
  bytes: Uint8Array,
  repository: string,
  sequence: number,
): BackupManifest {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Backup manifest exceeds limit');
  validateRepositoryName(repository);
  const value = record(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (
    value['format'] !== BACKUP_FORMAT_VERSION ||
    value['repository'] !== repository ||
    value['sequence'] !== sequence ||
    !positiveInteger(sequence) ||
    typeof value['capturedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['capturedAt'])) ||
    typeof value['release'] !== 'string' ||
    !/^[A-Za-z0-9._:+@/-]{1,256}$/.test(value['release']) ||
    !(typeof value['schema'] === 'string'
      ? /^[0-9]{4}_[a-z0-9_]{1,240}$/.test(value['schema'])
      : Number.isSafeInteger(value['schema']) && (value['schema'] as number) >= 0) ||
    !Array.isArray(value['files']) ||
    value['files'].length > MAX_MANIFEST_ENTRIES
  )
    throw new Error('Invalid backup manifest');
  if (
    value['kind'] !== undefined &&
    !['manual', 'scheduled', 'pre-update'].includes(value['kind'] as string)
  )
    throw new Error('Invalid backup kind');
  const seen = new Set<string>();
  const files: BackupFile[] = value['files'].map((raw) => {
    const file = record(raw);
    if (typeof file['path'] !== 'string') throw new Error('Invalid backup path');
    validateBackupPath(file['path']);
    if (seen.has(file['path'])) throw new Error('Duplicate backup path');
    seen.add(file['path']);
    if (
      !Number.isSafeInteger(file['mode']) ||
      (file['mode'] as number) < 0 ||
      (file['mode'] as number) > 0o777 ||
      !Array.isArray(file['objects']) ||
      file['objects'].length > MAX_OBJECTS_PER_FILE
    )
      throw new Error('Invalid backup file');
    const objects: BackupObject[] = file['objects'].map((rawObject) => {
      const object = record(rawObject);
      if (
        typeof object['id'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(object['id']) ||
        typeof object['digest'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(object['digest']) ||
        !positiveInteger(object['ciphertextBytes']) ||
        object['ciphertextBytes'] > 2 * 1024 * 1024 ||
        !positiveInteger(object['plaintextBytes']) ||
        object['plaintextBytes'] > 1024 * 1024
      )
        throw new Error('Invalid backup object');
      return {
        id: object['id'],
        digest: object['digest'],
        ciphertextBytes: object['ciphertextBytes'],
        plaintextBytes: object['plaintextBytes'],
      };
    });
    if (file['unstable'] !== undefined && typeof file['unstable'] !== 'boolean')
      throw new Error('Invalid backup consistency flag');
    return {
      path: file['path'],
      mode: file['mode'] as number,
      objects,
      ...(file['unstable'] === true ? { unstable: true } : {}),
    };
  });
  const directoryPaths = new Set<string>();
  const directories = parseAdditionalEntries(value['directories'], (entry) => {
    if (
      !Number.isSafeInteger(entry['mode']) ||
      (entry['mode'] as number) < 0 ||
      (entry['mode'] as number) > 0o777
    )
      throw new Error('Invalid backup directory');
    directoryPaths.add(entry['path'] as string);
    return { path: entry['path'] as string, mode: entry['mode'] as number };
  });
  const symlinks = parseAdditionalEntries(value['symlinks'], (entry) => {
    if (
      typeof entry['target'] !== 'string' ||
      entry['target'].length === 0 ||
      entry['target'].length > 8192 ||
      entry['target'].includes('\0')
    )
      throw new Error('Invalid backup symlink');
    return { path: entry['path'] as string, target: entry['target'] };
  });
  function parseAdditionalEntries<T>(
    raw: unknown,
    convert: (entry: Record<string, unknown>) => T,
  ): T[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length + seen.size > MAX_MANIFEST_ENTRIES)
      throw new Error('Backup path count exceeds limit');
    return raw.map((item) => {
      const entry = record(item);
      if (typeof entry['path'] !== 'string') throw new Error('Invalid backup path');
      validateBackupPath(entry['path']);
      if (seen.has(entry['path'])) throw new Error('Duplicate backup path');
      seen.add(entry['path']);
      return convert(entry);
    });
  }
  // A file or symlink cannot be an ancestor of any restored entry.
  for (const path of seen) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (seen.has(parent) && !directoryPaths.has(parent))
        throw new Error('Conflicting backup paths');
      parent = posix.dirname(parent);
    }
  }
  return {
    format: 1,
    repository,
    sequence,
    capturedAt: value['capturedAt'],
    release: value['release'],
    schema: value['schema'] as string | number,
    ...(value['capture'] === undefined
      ? {}
      : { capture: captureMetadataSchema.parse(value['capture']) }),
    kind: (value['kind'] ?? 'manual') as BackupKind,
    files,
    directories,
    symlinks,
  };
}
