import { z } from 'zod';
import {
  brokeredSecretsProtocolVersionSchema,
  canonicalJson,
  secretContractIdSchema,
  sha256HexSchema,
} from './common.js';

const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Protocol-v1 portable collision key over the schema's printable-ASCII path alphabet. */
function portablePathComponentKey(component: string): string {
  return component.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
const snapshotPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/, 'protocol v1 snapshot paths are printable ASCII only')
  .superRefine((path, ctx) => {
    if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
      ctx.addIssue({ code: 'custom', message: 'snapshot path must be relative POSIX text' });
    }
    const parts = path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..') || parts.length > 64) {
      ctx.addIssue({ code: 'custom', message: 'snapshot path has invalid segments or depth' });
    }
    if (utf8ByteLength(path) > 4096) {
      ctx.addIssue({ code: 'custom', message: 'snapshot path exceeds 4096 UTF-8 bytes' });
    }
  });

const fileEntrySchema = z
  .object({
    kind: z.literal('file'),
    path: snapshotPathSchema,
    source: z.enum(['tracked', 'modified', 'untracked', 'generated', 'explicit']),
    mode: z.enum(['100644', '100755']),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    contentHash: sha256HexSchema,
  })
  .strict();

const deletionEntrySchema = z
  .object({
    kind: z.literal('deletion'),
    path: snapshotPathSchema,
    baseContentHash: sha256HexSchema,
  })
  .strict();

const renameEntrySchema = z
  .object({
    kind: z.literal('rename'),
    from: snapshotPathSchema,
    path: snapshotPathSchema,
    mode: z.enum(['100644', '100755']),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    contentHash: sha256HexSchema,
  })
  .strict();

export const snapshotEntrySchema = z.discriminatedUnion('kind', [
  fileEntrySchema,
  deletionEntrySchema,
  renameEntrySchema,
]);
export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;

export const snapshotExclusionSchema = z
  .object({
    path: snapshotPathSchema,
    reason: z.enum([
      'profile',
      'gitignore',
      'vcs_metadata',
      'runtime_path',
      'credential_path',
      'special_file',
      'symlink',
      'hardlink',
      'mount_crossing',
      'submodule',
      'lfs_pointer',
      'size_limit',
      'explicitly_deselected',
    ]),
  })
  .strict();
export type SnapshotExclusion = z.infer<typeof snapshotExclusionSchema>;

export const snapshotManifestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    projectId: secretContractIdSchema,
    baseRevision: gitObjectIdSchema,
    snapshotPolicyHash: sha256HexSchema,
    sparseCheckout: z.boolean(),
    entries: z.array(snapshotEntrySchema).max(10_000),
    exclusions: z.array(snapshotExclusionSchema).max(10_000),
    fileCount: z.number().int().nonnegative().max(10_000),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024),
    contentRootHash: sha256HexSchema,
    snapshotId: sha256HexSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const files = manifest.entries.filter((entry) => entry.kind !== 'deletion');
    const bytes = files.reduce((total, entry) => total + entry.size, 0);
    if (files.length !== manifest.fileCount) {
      ctx.addIssue({ code: 'custom', path: ['fileCount'], message: 'fileCount mismatch' });
    }
    if (bytes !== manifest.totalBytes) {
      ctx.addIssue({ code: 'custom', path: ['totalBytes'], message: 'totalBytes mismatch' });
    }
    const paths = new Set<string>();
    for (const entry of manifest.entries) {
      const affected = entry.kind === 'rename' ? [entry.from, entry.path] : [entry.path];
      for (const path of affected) {
        if (paths.has(path)) ctx.addIssue({ code: 'custom', message: `duplicate path: ${path}` });
        paths.add(path);
      }
    }
    const destinationKeys = new Set<string>();
    const directoryComponents = new Map<string, Map<string, string>>();
    for (const entry of files) {
      const components = entry.path.split('/');
      const keyed = components.map(portablePathComponentKey);
      const destinationKey = keyed.join('/');
      if (destinationKeys.has(destinationKey)) {
        ctx.addIssue({ code: 'custom', message: `portable path collision: ${entry.path}` });
      }
      destinationKeys.add(destinationKey);
      for (let index = 0; index < components.length; index += 1) {
        const parent = keyed.slice(0, index).join('/');
        const siblings = directoryComponents.get(parent) ?? new Map<string, string>();
        const key = keyed[index]!;
        const existing = siblings.get(key);
        if (existing !== undefined && existing !== components[index]) {
          ctx.addIssue({ code: 'custom', message: `component collision: ${entry.path}` });
        }
        siblings.set(key, components[index]!);
        directoryComponents.set(parent, siblings);
      }
    }
    for (const destination of destinationKeys) {
      const parts = destination.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (destinationKeys.has(parts.slice(0, depth).join('/'))) {
          ctx.addIssue({
            code: 'custom',
            message: `file/directory ancestor collision: ${destination}`,
          });
        }
      }
    }
  });
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

const CONTENT_ROOT_DOMAIN = 'verity.snapshot.content-root.v1\0';
const SNAPSHOT_ID_DOMAIN = 'verity.snapshot.id.v1\0';

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entrySortKey(entry: SnapshotEntry): string {
  return canonicalJson([entry.kind, entry.kind === 'rename' ? entry.from : null, entry.path]);
}

export function snapshotContentRootPreimage(manifest: SnapshotManifest): string {
  return (
    CONTENT_ROOT_DOMAIN +
    canonicalJson(
      [...manifest.entries].sort((a, b) => compareCanonical(entrySortKey(a), entrySortKey(b))),
    )
  );
}

export function snapshotIdPreimage(manifest: SnapshotManifest): string {
  return (
    SNAPSHOT_ID_DOMAIN +
    canonicalJson({
      protocolVersion: manifest.protocolVersion,
      projectId: manifest.projectId,
      baseRevision: manifest.baseRevision,
      snapshotPolicyHash: manifest.snapshotPolicyHash,
      sparseCheckout: manifest.sparseCheckout,
      contentRootHash: manifest.contentRootHash,
      exclusions: [...manifest.exclusions].sort((a, b) =>
        compareCanonical(canonicalJson([a.path, a.reason]), canonicalJson([b.path, b.reason])),
      ),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    })
  );
}

export function validateSnapshotIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): SnapshotManifest {
  const manifest = snapshotManifestSchema.parse(input);
  const contentRootHash = sha256(snapshotContentRootPreimage(manifest));
  if (contentRootHash !== manifest.contentRootHash) throw new Error('contentRootHash mismatch');
  const snapshotId = sha256(snapshotIdPreimage(manifest));
  if (snapshotId !== manifest.snapshotId) throw new Error('snapshotId mismatch');
  return manifest;
}

export const snapshotPreviewSchema = z
  .object({
    snapshotId: sha256HexSchema,
    baseRevision: gitObjectIdSchema,
    fileCount: z.number().int().nonnegative(),
    deletionCount: z.number().int().nonnegative(),
    renameCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    sparseCheckout: z.boolean(),
    snapshotPolicyHash: sha256HexSchema,
    warnings: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict();
export type SnapshotPreview = z.infer<typeof snapshotPreviewSchema>;

export const snapshotApprovalContextSchema = z
  .object({ manifest: snapshotManifestSchema, preview: snapshotPreviewSchema })
  .strict()
  .superRefine(({ manifest, preview }, ctx) => {
    const deletionCount = manifest.entries.filter((entry) => entry.kind === 'deletion').length;
    const renameCount = manifest.entries.filter((entry) => entry.kind === 'rename').length;
    const expected = {
      snapshotId: manifest.snapshotId,
      baseRevision: manifest.baseRevision,
      fileCount: manifest.fileCount,
      deletionCount,
      renameCount,
      excludedCount: manifest.exclusions.length,
      totalBytes: manifest.totalBytes,
      sparseCheckout: manifest.sparseCheckout,
      snapshotPolicyHash: manifest.snapshotPolicyHash,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (preview[field as keyof typeof expected] !== value) {
        ctx.addIssue({ code: 'custom', path: ['preview', field], message: `${field} mismatch` });
      }
    }
  });
export type SnapshotApprovalContext = z.infer<typeof snapshotApprovalContextSchema>;
