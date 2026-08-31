import { z } from 'zod';
import {
  brokeredSecretsProtocolVersionSchema,
  canonicalJson,
  isoUtcTimestampSchema,
  jsonScalarSchema,
  secretContractIdSchema,
  secretTrustModeSchema,
  sha256HexSchema,
} from './common.js';
import {
  executionProfileRefSchema,
  providerBindingRefSchema,
  secretAliasRefSchema,
} from './catalog.js';

const boundedJsonSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    jsonScalarSchema,
    z.array(boundedJsonSchema).max(256),
    z.record(z.string().min(1).max(128), boundedJsonSchema),
  ]),
);

function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const children: readonly unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : Object.values(value as Record<string, unknown>);
  let maximumChildDepth = 0;
  for (const child of children) maximumChildDepth = Math.max(maximumChildDepth, jsonDepth(child));
  return 1 + maximumChildDepth;
}

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

export const validatedStructuredResultSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    resultSchemaHash: sha256HexSchema,
    mediaType: z.literal('application/json'),
    value: boundedJsonSchema,
    canonicalResultHash: sha256HexSchema,
    validatedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (jsonDepth(result.value) > 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'result exceeds maximum JSON depth',
      });
    }
    if (utf8ByteLength(canonicalJson(result.value)) > 1_048_576) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'result exceeds 1 MiB' });
    }
  });
export type ValidatedStructuredResult = z.infer<typeof validatedStructuredResultSchema>;

export function structuredResultPreimage(result: ValidatedStructuredResult): string {
  return (
    'verity.structured-result.v1\0' +
    canonicalJson({
      jobId: result.jobId,
      resultSchemaHash: result.resultSchemaHash,
      mediaType: result.mediaType,
      value: result.value,
    })
  );
}

export function validateStructuredResultIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): ValidatedStructuredResult {
  const result = validatedStructuredResultSchema.parse(input);
  if (sha256(structuredResultPreimage(result)) !== result.canonicalResultHash) {
    throw new Error('canonicalResultHash mismatch');
  }
  return result;
}

export const structuredResultExchangeSchema = z
  .object({
    expectedJobId: secretContractIdSchema,
    expectedResultSchemaHash: sha256HexSchema,
    result: validatedStructuredResultSchema,
  })
  .strict()
  .superRefine((exchange, ctx) => {
    if (exchange.result.jobId !== exchange.expectedJobId) {
      ctx.addIssue({ code: 'custom', path: ['result', 'jobId'], message: 'result job mismatch' });
    }
    if (exchange.result.resultSchemaHash !== exchange.expectedResultSchemaHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['result', 'resultSchemaHash'],
        message: 'result schema mismatch',
      });
    }
  });
export type StructuredResultExchange = z.infer<typeof structuredResultExchangeSchema>;

export function validateStructuredResultExchangeIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): StructuredResultExchange {
  const exchange = structuredResultExchangeSchema.parse(input);
  validateStructuredResultIdentity(exchange.result, sha256);
  return exchange;
}

export const artifactConsumerSchema = z.enum([
  'external_destination',
  'quarantine_only',
  'user_download',
  'agent',
  'worktree_import',
]);
export type ArtifactConsumer = z.infer<typeof artifactConsumerSchema>;

export const resultTrustClassificationSchema = z
  .object({
    requestedMode: secretTrustModeSchema,
    opaqueArtifact: z.boolean(),
    consumers: z.array(artifactConsumerSchema).min(1).max(5),
    effectiveMode: secretTrustModeSchema,
  })
  .strict()
  .superRefine((classification, ctx) => {
    const agentReadable = classification.consumers.some((consumer) =>
      ['user_download', 'agent', 'worktree_import'].includes(consumer),
    );
    const requiresTrusted = classification.opaqueArtifact && agentReadable;
    const expectedMode = requiresTrusted ? 'trusted' : classification.requestedMode;
    if (classification.effectiveMode !== expectedMode) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveMode'],
        message: requiresTrusted
          ? 'opaque agent-readable artifacts require trusted mode'
          : 'effective mode must equal requested mode',
      });
    }
  });
export type ResultTrustClassification = z.infer<typeof resultTrustClassificationSchema>;

const artifactPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x20-\x7e]+$/)
  .refine((path) => !path.startsWith('/') && !path.endsWith('/'), 'artifact path must be relative')
  .refine(
    (path) =>
      path
        .split('/')
        .every((component) => component !== '' && component !== '.' && component !== '..'),
    'artifact path contains unsafe component',
  );

export const quarantinedArtifactEntrySchema = z
  .object({
    path: artifactPathSchema,
    contentHash: sha256HexSchema,
    bytes: z.number().int().nonnegative().max(268_435_456),
    mediaType: z.string().min(1).max(128),
    executable: z.literal(false),
  })
  .strict();
export type QuarantinedArtifactEntry = z.infer<typeof quarantinedArtifactEntrySchema>;

export const quarantinedArtifactManifestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    artifactId: sha256HexSchema,
    jobId: secretContractIdSchema,
    projectId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    trustMode: secretTrustModeSchema,
    state: z.enum(['quarantined', 'released', 'deleting', 'deleted']),
    entries: z.array(quarantinedArtifactEntrySchema).min(1).max(1024),
    totalBytes: z.number().int().nonnegative().max(1_073_741_824),
    createdAt: isoUtcTimestampSchema,
    expiresAt: isoUtcTimestampSchema,
    provenanceHash: sha256HexSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = new Set<string>();
    let bytes = 0;
    for (const [index, entry] of manifest.entries.entries()) {
      const folded = entry.path.toLowerCase();
      if (paths.has(folded)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'path'],
          message: 'artifact path collision',
        });
      }
      paths.add(folded);
      bytes += entry.bytes;
    }
    for (const path of paths) {
      const parts = path.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (paths.has(parts.slice(0, depth).join('/'))) {
          ctx.addIssue({ code: 'custom', message: `artifact ancestor collision: ${path}` });
        }
      }
    }
    if (bytes !== manifest.totalBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalBytes'],
        message: 'artifact byte total mismatch',
      });
    }
    if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.createdAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'artifact expiry must follow creation',
      });
    }
  });
export type QuarantinedArtifactManifest = z.infer<typeof quarantinedArtifactManifestSchema>;

export function quarantinedArtifactPreimage(manifest: QuarantinedArtifactManifest): string {
  return (
    'verity.quarantined-artifact.v1\0' +
    canonicalJson(
      [...manifest.entries].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    )
  );
}

export function validateQuarantinedArtifactIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): QuarantinedArtifactManifest {
  const manifest = quarantinedArtifactManifestSchema.parse(input);
  if (sha256(quarantinedArtifactPreimage(manifest)) !== manifest.artifactId) {
    throw new Error('artifactId mismatch');
  }
  return manifest;
}

export const artifactReleaseAuthorizationSchema = z
  .object({
    releaseId: secretContractIdSchema,
    releaseHash: sha256HexSchema,
    artifactId: sha256HexSchema,
    projectId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    provenanceHash: sha256HexSchema,
    approvalId: secretContractIdSchema,
    purpose: z.literal('worktree_import'),
    authorizedAt: isoUtcTimestampSchema,
    expiresAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((release, ctx) => {
    if (Date.parse(release.expiresAt) <= Date.parse(release.authorizedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'release expiry must follow authorization',
      });
    }
  });
export type ArtifactReleaseAuthorization = z.infer<typeof artifactReleaseAuthorizationSchema>;

export function artifactReleasePreimage(release: ArtifactReleaseAuthorization): string {
  const claims = Object.fromEntries(
    Object.entries(release).filter(([key]) => key !== 'releaseHash'),
  );
  return 'verity.artifact-release.v1\0' + canonicalJson(claims);
}

export function validateArtifactReleaseIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): ArtifactReleaseAuthorization {
  const release = artifactReleaseAuthorizationSchema.parse(input);
  if (sha256(artifactReleasePreimage(release)) !== release.releaseHash) {
    throw new Error('releaseHash mismatch');
  }
  return release;
}

export const artifactImportRequestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    importId: secretContractIdSchema,
    artifactId: sha256HexSchema,
    projectId: secretContractIdSchema,
    approvalId: secretContractIdSchema,
    targetRoot: z.literal('docs/reference'),
    entries: z
      .array(
        z
          .object({
            artifactPath: artifactPathSchema,
            targetPath: artifactPathSchema,
            contentHash: sha256HexSchema,
            expectedCurrentHash: sha256HexSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1024),
    conflictPolicy: z.literal('fail'),
    autoCommit: z.literal(false),
    requestedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const targets = new Set<string>();
    for (const [index, entry] of request.entries.entries()) {
      const key = entry.targetPath.toLowerCase();
      if (targets.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'targetPath'],
          message: 'duplicate import target',
        });
      }
      targets.add(key);
    }
    for (const target of targets) {
      const parts = target.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (targets.has(parts.slice(0, depth).join('/'))) {
          ctx.addIssue({ code: 'custom', message: `import target ancestor collision: ${target}` });
        }
      }
    }
  });
export type ArtifactImportRequest = z.infer<typeof artifactImportRequestSchema>;

export const artifactImportResultSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    importId: secretContractIdSchema,
    artifactId: sha256HexSchema,
    disposition: z.enum(['imported', 'conflict', 'artifact_unavailable', 'hash_mismatch']),
    importedPaths: z.array(artifactPathSchema).max(1024),
    conflictPaths: z.array(artifactPathSchema).max(1024),
    completedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.disposition === 'imported' && result.conflictPaths.length !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['conflictPaths'],
        message: 'successful import forbids conflicts',
      });
    }
    if (result.disposition !== 'imported' && result.importedPaths.length !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['importedPaths'],
        message: 'failed import must be atomic',
      });
    }
  });
export type ArtifactImportResult = z.infer<typeof artifactImportResultSchema>;

export const artifactImportExchangeSchema = z
  .object({
    manifest: quarantinedArtifactManifestSchema,
    release: artifactReleaseAuthorizationSchema,
    request: artifactImportRequestSchema,
    result: artifactImportResultSchema,
  })
  .strict()
  .superRefine((exchange, ctx) => {
    if (exchange.manifest.state !== 'released' || exchange.manifest.trustMode !== 'trusted') {
      ctx.addIssue({
        code: 'custom',
        path: ['manifest'],
        message: 'import requires released trusted artifact',
      });
    }
    if (
      exchange.request.artifactId !== exchange.manifest.artifactId ||
      exchange.result.artifactId !== exchange.manifest.artifactId ||
      exchange.result.importId !== exchange.request.importId
    ) {
      ctx.addIssue({ code: 'custom', message: 'import identity mismatch' });
    }
    if (
      exchange.release.artifactId !== exchange.manifest.artifactId ||
      exchange.release.projectId !== exchange.manifest.projectId ||
      exchange.release.projectId !== exchange.request.projectId ||
      exchange.release.jobId !== exchange.manifest.jobId ||
      exchange.release.requestHash !== exchange.manifest.requestHash ||
      exchange.release.provenanceHash !== exchange.manifest.provenanceHash ||
      exchange.release.approvalId !== exchange.request.approvalId
    ) {
      ctx.addIssue({ code: 'custom', path: ['release'], message: 'release context mismatch' });
    }
    const requestedAt = Date.parse(exchange.request.requestedAt);
    if (
      requestedAt < Date.parse(exchange.release.authorizedAt) ||
      requestedAt >= Date.parse(exchange.release.expiresAt) ||
      requestedAt >= Date.parse(exchange.manifest.expiresAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['request', 'requestedAt'],
        message: 'import request outside release or artifact validity window',
      });
    }
    const manifestEntries = new Map(
      exchange.manifest.entries.map((entry) => [entry.path, entry.contentHash]),
    );
    for (const [index, entry] of exchange.request.entries.entries()) {
      if (manifestEntries.get(entry.artifactPath) !== entry.contentHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['request', 'entries', index],
          message: 'import source not bound to manifest',
        });
      }
    }
    const requestedTargets = [...exchange.request.entries.map((entry) => entry.targetPath)].sort();
    const imported = [...exchange.result.importedPaths].sort();
    if (
      exchange.result.disposition === 'imported' &&
      canonicalJson(imported) !== canonicalJson(requestedTargets)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['result', 'importedPaths'],
        message: 'successful import must cover exact targets',
      });
    }
    const targetSet = new Set(requestedTargets);
    if (exchange.result.conflictPaths.some((path) => !targetSet.has(path))) {
      ctx.addIssue({
        code: 'custom',
        path: ['result', 'conflictPaths'],
        message: 'foreign conflict path',
      });
    }
  });
export type ArtifactImportExchange = z.infer<typeof artifactImportExchangeSchema>;

export function validateArtifactImportExchangeIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): ArtifactImportExchange {
  const exchange = artifactImportExchangeSchema.parse(input);
  validateQuarantinedArtifactIdentity(exchange.manifest, sha256);
  validateArtifactReleaseIdentity(exchange.release, sha256);
  return exchange;
}

export const remoteResourceCleanupSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    cleanupId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    binding: providerBindingRefSchema,
    resourceType: secretContractIdSchema,
    resourceIdHash: sha256HexSchema,
    idempotencyKey: sha256HexSchema,
    deadline: isoUtcTimestampSchema,
    disposition: z.enum(['pending', 'complete', 'retry', 'attention']),
    attempt: z.number().int().positive().max(100),
    retryAfterSeconds: z.number().int().positive().max(3600).optional(),
  })
  .strict()
  .superRefine((cleanup, ctx) => {
    if ((cleanup.disposition === 'retry') !== (cleanup.retryAfterSeconds !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['retryAfterSeconds'],
        message: 'retry delay mismatch',
      });
    }
  });
export type RemoteResourceCleanup = z.infer<typeof remoteResourceCleanupSchema>;

export function remoteCleanupIdempotencyPreimage(cleanup: RemoteResourceCleanup): string {
  return (
    'verity.remote-cleanup.v1\0' +
    canonicalJson({
      jobId: cleanup.jobId,
      binding: cleanup.binding,
      resourceType: cleanup.resourceType,
      resourceIdHash: cleanup.resourceIdHash,
    })
  );
}

export function validateRemoteCleanupIdentity(
  input: unknown,
  sha256: (preimage: string) => string,
): RemoteResourceCleanup {
  const cleanup = remoteResourceCleanupSchema.parse(input);
  if (sha256(remoteCleanupIdempotencyPreimage(cleanup)) !== cleanup.idempotencyKey) {
    throw new Error('cleanup idempotencyKey mismatch');
  }
  return cleanup;
}

export const completedSecretAuditRecordSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    auditId: secretContractIdSchema,
    projectId: secretContractIdSchema,
    sessionId: secretContractIdSchema,
    toolCallId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    grantId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    aliases: z.array(secretAliasRefSchema).max(16),
    providerBindings: z.array(providerBindingRefSchema).max(16),
    profile: executionProfileRefSchema,
    requestedMode: secretTrustModeSchema,
    effectiveMode: secretTrustModeSchema,
    egressPolicyHash: sha256HexSchema.optional(),
    snapshotId: sha256HexSchema.optional(),
    imageDigest: sha256HexSchema,
    executableDigest: sha256HexSchema,
    approvalId: secretContractIdSchema.optional(),
    redactor: z
      .object({
        id: secretContractIdSchema,
        version: z.number().int().positive(),
        implementationDigest: sha256HexSchema,
      })
      .strict(),
    resultHash: sha256HexSchema.optional(),
    artifactId: sha256HexSchema.optional(),
    delivery: z.enum(['none', 'structured', 'artifact', 'external']),
    outcome: z.enum(['denied', 'failed', 'cancelled', 'succeeded']),
    executorCleanup: z.enum(['not_started', 'pending', 'complete', 'attention']),
    remoteCleanup: z.enum(['not_required', 'pending', 'complete', 'attention']),
    recordedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((audit, ctx) => {
    if (
      audit.delivery === 'structured' &&
      (audit.resultHash === undefined || audit.artifactId !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'structured delivery requires only resultHash',
      });
    }
    if (
      audit.delivery === 'artifact' &&
      (audit.artifactId === undefined || audit.resultHash !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'artifact delivery requires only artifactId',
      });
    }
    if (
      audit.delivery === 'external' &&
      (audit.resultHash !== undefined || audit.artifactId !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'external delivery forbids local result references',
      });
    }
    if (
      audit.delivery === 'none' &&
      (audit.resultHash !== undefined || audit.artifactId !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'empty delivery forbids result references',
      });
    }
    if ((audit.outcome === 'succeeded') !== (audit.delivery !== 'none')) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'outcome and delivery mismatch',
      });
    }
    if (audit.delivery === 'artifact' && audit.effectiveMode !== 'trusted') {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveMode'],
        message: 'artifact audit requires trusted mode',
      });
    }
  });
export type CompletedSecretAuditRecord = z.infer<typeof completedSecretAuditRecordSchema>;
