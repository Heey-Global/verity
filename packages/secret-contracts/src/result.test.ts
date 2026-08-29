import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  artifactImportExchangeSchema,
  artifactImportRequestSchema,
  artifactImportResultSchema,
  artifactReleaseAuthorizationSchema,
  artifactReleasePreimage,
  completedSecretAuditRecordSchema,
  quarantinedArtifactManifestSchema,
  quarantinedArtifactPreimage,
  remoteCleanupIdempotencyPreimage,
  remoteResourceCleanupSchema,
  resultTrustClassificationSchema,
  structuredResultExchangeSchema,
  structuredResultPreimage,
  validateArtifactImportExchangeIdentity,
  validateArtifactReleaseIdentity,
  validateQuarantinedArtifactIdentity,
  validateRemoteCleanupIdentity,
  validateStructuredResultExchangeIdentity,
  validateStructuredResultIdentity,
  validatedStructuredResultSchema,
} from './result.js';

const hash = 'a'.repeat(64);
const later = '2026-07-19T00:00:00Z';
const now = '2026-07-18T00:00:00Z';
const otherHash = 'b'.repeat(64);
const releaseHash = 'e'.repeat(64);

/** Refusals as `["path","to","field"] message`, so assertions pin both. */
function refusals(outcome: z.ZodSafeParseResult<unknown>): string[] {
  expect(outcome.success).toBe(false);
  return outcome.success
    ? []
    : outcome.error.issues.map((issue) => `${JSON.stringify(issue.path)} ${issue.message}`);
}

const structuredResult = {
  protocolVersion: 1,
  jobId: 'job-1',
  resultSchemaHash: hash,
  mediaType: 'application/json',
  value: { items: [1, 2] } as unknown,
  canonicalResultHash: hash,
  validatedAt: now,
};

const manifestEntry = {
  path: 'report.md',
  contentHash: hash,
  bytes: 42,
  mediaType: 'text/markdown',
  executable: false,
};

const quarantineManifest = {
  protocolVersion: 1,
  artifactId: hash,
  jobId: 'job-1',
  projectId: 'project-1',
  requestHash: hash,
  trustMode: 'trusted',
  state: 'released',
  entries: [manifestEntry],
  totalBytes: 42,
  createdAt: now,
  expiresAt: later,
  provenanceHash: hash,
};

const releaseAuthorization = {
  releaseId: 'release-1',
  releaseHash,
  artifactId: hash,
  projectId: 'project-1',
  jobId: 'job-1',
  requestHash: hash,
  provenanceHash: hash,
  approvalId: 'approval-1',
  purpose: 'worktree_import',
  authorizedAt: now,
  expiresAt: later,
};

const importEntry = {
  artifactPath: 'report.md',
  targetPath: 'report.md',
  contentHash: hash,
  expectedCurrentHash: null,
};

const importRequest = {
  protocolVersion: 1,
  importId: 'import-1',
  artifactId: hash,
  projectId: 'project-1',
  approvalId: 'approval-1',
  targetRoot: 'docs/reference',
  entries: [importEntry],
  conflictPolicy: 'fail',
  autoCommit: false,
  requestedAt: now,
};

const importOutcome = {
  protocolVersion: 1,
  importId: 'import-1',
  artifactId: hash,
  disposition: 'imported',
  importedPaths: ['report.md'],
  conflictPaths: [] as string[],
  completedAt: now,
};

const importExchange = {
  manifest: quarantineManifest,
  release: releaseAuthorization,
  request: importRequest,
  result: importOutcome,
};

const remoteCleanup = {
  protocolVersion: 1,
  cleanupId: 'cleanup-1',
  jobId: 'job-1',
  binding: { id: 'binding-1', version: 1, provider: 'doppler' },
  resourceType: 'remote-build',
  resourceIdHash: hash,
  idempotencyKey: hash,
  deadline: later,
  disposition: 'complete',
  attempt: 2,
};

const auditRecord = {
  protocolVersion: 1,
  auditId: 'audit-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  jobId: 'job-1',
  grantId: 'grant-1',
  requestHash: hash,
  aliases: [],
  providerBindings: [],
  profile: { id: 'profile-1', version: 1, policyHash: hash },
  requestedMode: 'restricted',
  effectiveMode: 'restricted',
  imageDigest: hash,
  executableDigest: hash,
  redactor: { id: 'redactor-v1', version: 1, implementationDigest: hash },
  outcome: 'succeeded',
  delivery: 'external',
  executorCleanup: 'complete',
  remoteCleanup: 'not_required',
  recordedAt: now,
};

describe('W9 result and artifact contracts', () => {
  it('bounds structured results and rejects extra raw output fields', () => {
    const result = {
      protocolVersion: 1,
      jobId: 'job-1',
      resultSchemaHash: hash,
      mediaType: 'application/json',
      value: { items: [1, 2] },
      canonicalResultHash: hash,
      validatedAt: now,
    };
    expect(validatedStructuredResultSchema.parse(result).jobId).toBe('job-1');
    expect(() => validatedStructuredResultSchema.parse({ ...result, stdout: 'secret' })).toThrow();
    expect(() =>
      structuredResultExchangeSchema.parse({
        expectedJobId: 'other-job',
        expectedResultSchemaHash: hash,
        result,
      }),
    ).toThrow(/job mismatch/);
  });

  it('forces opaque agent-readable artifacts to trusted mode', () => {
    const classification = {
      requestedMode: 'restricted',
      opaqueArtifact: true,
      consumers: ['agent'],
      effectiveMode: 'restricted',
    };
    expect(() => resultTrustClassificationSchema.parse(classification)).toThrow(/trusted mode/);
    expect(
      resultTrustClassificationSchema.parse({
        ...classification,
        consumers: ['external_destination'],
      }).effectiveMode,
    ).toBe('restricted');
    expect(() =>
      resultTrustClassificationSchema.parse({
        requestedMode: 'trusted',
        opaqueArtifact: false,
        consumers: ['external_destination'],
        effectiveMode: 'restricted',
      }),
    ).toThrow(/equal requested/);
  });

  it('requires collision-free content-addressed quarantine manifests', () => {
    const entry = {
      path: 'build/output.bin',
      contentHash: hash,
      bytes: 42,
      mediaType: 'application/octet-stream',
      executable: false,
    };
    const manifest = {
      protocolVersion: 1,
      artifactId: hash,
      jobId: 'job-1',
      projectId: 'project-1',
      requestHash: hash,
      trustMode: 'trusted',
      state: 'quarantined',
      entries: [entry],
      totalBytes: 42,
      createdAt: now,
      expiresAt: later,
      provenanceHash: hash,
    };
    expect(quarantinedArtifactManifestSchema.parse(manifest).totalBytes).toBe(42);
    expect(() => quarantinedArtifactManifestSchema.parse({ ...manifest, totalBytes: 41 })).toThrow(
      /total mismatch/,
    );
    expect(() =>
      quarantinedArtifactManifestSchema.parse({
        ...manifest,
        entries: [entry, { ...entry, path: 'BUILD/output.bin' }],
        totalBytes: 84,
      }),
    ).toThrow(/collision/);
    expect(() =>
      quarantinedArtifactManifestSchema.parse({
        ...manifest,
        entries: [{ ...entry, path: 'build' }, entry],
        totalBytes: 84,
      }),
    ).toThrow(/ancestor collision/);
  });

  it('makes imports explicit, atomic, conflict-safe, and non-committing', () => {
    const request = {
      protocolVersion: 1,
      importId: 'import-1',
      artifactId: hash,
      projectId: 'project-1',
      approvalId: 'approval-1',
      targetRoot: 'docs/reference',
      entries: [
        {
          artifactPath: 'report.md',
          targetPath: 'report.md',
          contentHash: hash,
          expectedCurrentHash: null,
        },
      ],
      conflictPolicy: 'fail',
      autoCommit: false,
      requestedAt: now,
    };
    expect(artifactImportRequestSchema.parse(request).autoCommit).toBe(false);
    expect(() => artifactImportRequestSchema.parse({ ...request, autoCommit: true })).toThrow();
    expect(() =>
      artifactImportResultSchema.parse({
        protocolVersion: 1,
        importId: 'import-1',
        artifactId: hash,
        disposition: 'conflict',
        importedPaths: ['partial.md'],
        conflictPaths: ['report.md'],
        completedAt: now,
      }),
    ).toThrow(/atomic/);
    const manifest = {
      protocolVersion: 1,
      artifactId: hash,
      jobId: 'job-1',
      projectId: 'project-1',
      requestHash: hash,
      trustMode: 'trusted',
      state: 'released',
      entries: [
        {
          path: 'report.md',
          contentHash: hash,
          bytes: 42,
          mediaType: 'text/markdown',
          executable: false,
        },
      ],
      totalBytes: 42,
      createdAt: now,
      expiresAt: later,
      provenanceHash: hash,
    };
    const release = {
      releaseId: 'release-1',
      releaseHash: hash,
      artifactId: hash,
      projectId: 'project-1',
      jobId: 'job-1',
      requestHash: hash,
      provenanceHash: hash,
      approvalId: 'approval-1',
      purpose: 'worktree_import',
      authorizedAt: now,
      expiresAt: later,
    };
    const result = {
      protocolVersion: 1,
      importId: 'import-1',
      artifactId: hash,
      disposition: 'imported',
      importedPaths: [],
      conflictPaths: [],
      completedAt: now,
    };
    expect(() =>
      artifactImportExchangeSchema.parse({ manifest, release, request, result }),
    ).toThrow(/exact targets/);
    expect(() =>
      artifactImportExchangeSchema.parse({
        manifest,
        release,
        request: { ...request, requestedAt: '2026-07-20T00:00:00Z' },
        result,
      }),
    ).toThrow(/validity window/);
  });

  it('keeps provider cleanup idempotent and credential-free', () => {
    const cleanup = {
      protocolVersion: 1,
      cleanupId: 'cleanup-1',
      jobId: 'job-1',
      binding: { id: 'binding-1', version: 1, provider: 'doppler' },
      resourceType: 'remote-build',
      resourceIdHash: hash,
      idempotencyKey: hash,
      deadline: later,
      disposition: 'retry',
      attempt: 2,
      retryAfterSeconds: 30,
    };
    expect(remoteResourceCleanupSchema.parse(cleanup).attempt).toBe(2);
    expect(() =>
      remoteResourceCleanupSchema.parse({ ...cleanup, providerToken: 'nope' }),
    ).toThrow();
  });

  it('provides a complete safe audit projection', () => {
    const audit = {
      protocolVersion: 1,
      auditId: 'audit-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      jobId: 'job-1',
      grantId: 'grant-1',
      requestHash: hash,
      aliases: [],
      providerBindings: [],
      profile: { id: 'profile-1', version: 1, policyHash: hash },
      requestedMode: 'restricted',
      effectiveMode: 'restricted',
      imageDigest: hash,
      executableDigest: hash,
      redactor: { id: 'redactor-v1', version: 1, implementationDigest: hash },
      outcome: 'succeeded',
      delivery: 'external',
      executorCleanup: 'complete',
      remoteCleanup: 'not_required',
      recordedAt: now,
    };
    expect(completedSecretAuditRecordSchema.parse(audit).outcome).toBe('succeeded');
    expect(() =>
      completedSecretAuditRecordSchema.parse({ ...audit, secretValue: 'nope' }),
    ).toThrow();
  });

  it('caps structured result nesting depth', () => {
    const nest = (depth: number): unknown => (depth === 0 ? 'leaf' : { next: nest(depth - 1) });
    expect(
      validatedStructuredResultSchema.parse({ ...structuredResult, value: nest(16) }).jobId,
    ).toBe('job-1');
    expect(
      refusals(validatedStructuredResultSchema.safeParse({ ...structuredResult, value: nest(17) })),
    ).toContain('["value"] result exceeds maximum JSON depth');
  });

  it('measures the structured result budget in UTF-8 bytes, not UTF-16 code units', () => {
    const tooLarge = '["value"] result exceeds 1 MiB';
    const accepts = (value: string): boolean =>
      validatedStructuredResultSchema.safeParse({ ...structuredResult, value }).success;
    const rejects = (value: string): string[] =>
      refusals(validatedStructuredResultSchema.safeParse({ ...structuredResult, value }));
    // Canonical JSON wraps a string value in two quote bytes, so the budget is
    // 1 MiB minus 2 for the payload itself.
    expect(accepts('é'.repeat(524_287))).toBe(true);
    expect(rejects('é'.repeat(524_288))).toContain(tooLarge);
    expect(accepts('€'.repeat(349_524))).toBe(true);
    expect(rejects('€'.repeat(349_525))).toContain(tooLarge);
    expect(accepts('😀'.repeat(262_143))).toBe(true);
    expect(rejects('😀'.repeat(262_144))).toContain(tooLarge);
  });

  it('binds a structured result to a hash over its job, schema, and value only', () => {
    const parsed = validatedStructuredResultSchema.parse(structuredResult);
    expect(structuredResultPreimage(parsed)).toBe(
      `verity.structured-result.v1\0{"jobId":"job-1","mediaType":"application/json","resultSchemaHash":"${hash}","value":{"items":[1,2]}}`,
    );
    const sha256 = (preimage: string): string =>
      preimage.startsWith('verity.structured-result.v1\0') ? hash : otherHash;
    expect(validateStructuredResultIdentity(structuredResult, sha256).jobId).toBe('job-1');
    expect(() =>
      validateStructuredResultIdentity(
        { ...structuredResult, canonicalResultHash: otherHash },
        sha256,
      ),
    ).toThrow('canonicalResultHash mismatch');
  });

  it('binds a structured result exchange to the expected job, schema, and hash', () => {
    const sha256 = (preimage: string): string =>
      preimage.startsWith('verity.structured-result.v1\0') ? hash : otherHash;
    const exchange = {
      expectedJobId: 'job-1',
      expectedResultSchemaHash: hash,
      result: structuredResult,
    };
    expect(validateStructuredResultExchangeIdentity(exchange, sha256).expectedJobId).toBe('job-1');
    expect(
      refusals(
        structuredResultExchangeSchema.safeParse({
          ...exchange,
          expectedResultSchemaHash: otherHash,
        }),
      ),
    ).toContain('["result","resultSchemaHash"] result schema mismatch');
    expect(() =>
      validateStructuredResultExchangeIdentity(
        { ...exchange, result: { ...structuredResult, canonicalResultHash: otherHash } },
        sha256,
      ),
    ).toThrow('canonicalResultHash mismatch');
  });

  it('binds the artifact id to a path-ordered manifest preimage', () => {
    const second = { ...manifestEntry, path: 'audit.md', contentHash: otherHash, bytes: 8 };
    const ordered = quarantinedArtifactManifestSchema.parse({
      ...quarantineManifest,
      entries: [manifestEntry, second],
      totalBytes: 50,
    });
    const reversed = quarantinedArtifactManifestSchema.parse({
      ...quarantineManifest,
      entries: [second, manifestEntry],
      totalBytes: 50,
    });
    const preimage = quarantinedArtifactPreimage(ordered);
    expect(preimage).toBe(quarantinedArtifactPreimage(reversed));
    expect(preimage.indexOf('audit.md')).toBeLessThan(preimage.indexOf('report.md'));
    expect(preimage.startsWith('verity.quarantined-artifact.v1\0')).toBe(true);
    const sha256 = (value: string): string =>
      value.startsWith('verity.quarantined-artifact.v1\0') ? hash : otherHash;
    expect(validateQuarantinedArtifactIdentity(quarantineManifest, sha256).artifactId).toBe(hash);
    expect(() =>
      validateQuarantinedArtifactIdentity({ ...quarantineManifest, artifactId: otherHash }, sha256),
    ).toThrow('artifactId mismatch');
    expect(
      refusals(
        quarantinedArtifactManifestSchema.safeParse({ ...quarantineManifest, expiresAt: now }),
      ),
    ).toContain('["expiresAt"] artifact expiry must follow creation');
  });

  it('binds a release to every claim except its own hash', () => {
    const release = artifactReleaseAuthorizationSchema.parse(releaseAuthorization);
    const preimage = artifactReleasePreimage(release);
    expect(preimage.startsWith('verity.artifact-release.v1\0')).toBe(true);
    expect(preimage).toContain('"releaseId":"release-1"');
    expect(preimage).toContain('"approvalId":"approval-1"');
    expect(preimage).not.toContain(releaseHash);
    const sha256 = (value: string): string =>
      value.startsWith('verity.artifact-release.v1\0') ? releaseHash : otherHash;
    expect(validateArtifactReleaseIdentity(releaseAuthorization, sha256).releaseId).toBe(
      'release-1',
    );
    expect(() =>
      validateArtifactReleaseIdentity({ ...releaseAuthorization, releaseHash: otherHash }, sha256),
    ).toThrow('releaseHash mismatch');
    expect(
      refusals(
        artifactReleaseAuthorizationSchema.safeParse({ ...releaseAuthorization, expiresAt: now }),
      ),
    ).toContain('["expiresAt"] release expiry must follow authorization');
  });

  it('rejects duplicate and ancestor-colliding import targets', () => {
    expect(
      refusals(
        artifactImportRequestSchema.safeParse({
          ...importRequest,
          entries: [
            importEntry,
            { ...importEntry, artifactPath: 'other.md', targetPath: 'REPORT.md' },
          ],
        }),
      ),
    ).toContain('["entries",1,"targetPath"] duplicate import target');
    expect(
      refusals(
        artifactImportRequestSchema.safeParse({
          ...importRequest,
          entries: [
            { ...importEntry, artifactPath: 'notes', targetPath: 'notes' },
            { ...importEntry, artifactPath: 'notes/report.md', targetPath: 'notes/report.md' },
          ],
        }),
      ),
    ).toContain('[] import target ancestor collision: notes/report.md');
  });

  it('forbids conflicts on a successful import', () => {
    expect(
      refusals(
        artifactImportResultSchema.safeParse({ ...importOutcome, conflictPaths: ['report.md'] }),
      ),
    ).toContain('["conflictPaths"] successful import forbids conflicts');
  });

  it('refuses import exchanges that are not bound end to end', () => {
    expect(artifactImportExchangeSchema.parse(importExchange).result.disposition).toBe('imported');
    const untrusted = '["manifest"] import requires released trusted artifact';
    expect(
      refusals(
        artifactImportExchangeSchema.safeParse({
          ...importExchange,
          manifest: { ...quarantineManifest, state: 'quarantined' },
        }),
      ),
    ).toContain(untrusted);
    expect(
      refusals(
        artifactImportExchangeSchema.safeParse({
          ...importExchange,
          manifest: { ...quarantineManifest, trustMode: 'restricted' },
        }),
      ),
    ).toContain(untrusted);
    expect(
      refusals(
        artifactImportExchangeSchema.safeParse({
          ...importExchange,
          result: { ...importOutcome, importId: 'import-2' },
        }),
      ),
    ).toContain('[] import identity mismatch');
    expect(
      refusals(
        artifactImportExchangeSchema.safeParse({
          ...importExchange,
          release: { ...releaseAuthorization, approvalId: 'approval-2' },
        }),
      ),
    ).toContain('["release"] release context mismatch');
    expect(
      refusals(
        artifactImportExchangeSchema.safeParse({
          ...importExchange,
          request: { ...importRequest, entries: [{ ...importEntry, contentHash: otherHash }] },
        }),
      ),
    ).toContain('["request","entries",0] import source not bound to manifest');
    expect(
      refusals(
        artifactImportExchangeSchema.safeParse({
          ...importExchange,
          result: {
            ...importOutcome,
            disposition: 'conflict',
            importedPaths: [],
            conflictPaths: ['stranger.md'],
          },
        }),
      ),
    ).toContain('["result","conflictPaths"] foreign conflict path');
  });

  it('revalidates manifest and release identities inside an import exchange', () => {
    const sha256 = (preimage: string): string => {
      if (preimage.startsWith('verity.quarantined-artifact.v1\0')) return hash;
      return preimage.startsWith('verity.artifact-release.v1\0') ? releaseHash : otherHash;
    };
    expect(validateArtifactImportExchangeIdentity(importExchange, sha256).request.importId).toBe(
      'import-1',
    );
    expect(() =>
      validateArtifactImportExchangeIdentity(
        {
          manifest: { ...quarantineManifest, artifactId: otherHash },
          release: { ...releaseAuthorization, artifactId: otherHash },
          request: { ...importRequest, artifactId: otherHash },
          result: { ...importOutcome, artifactId: otherHash },
        },
        sha256,
      ),
    ).toThrow('artifactId mismatch');
    expect(() =>
      validateArtifactImportExchangeIdentity(
        { ...importExchange, release: { ...releaseAuthorization, releaseHash: otherHash } },
        sha256,
      ),
    ).toThrow('releaseHash mismatch');
  });

  it('pairs a retry disposition with a retry delay and binds the idempotency key', () => {
    const delayMismatch = '["retryAfterSeconds"] retry delay mismatch';
    expect(
      refusals(remoteResourceCleanupSchema.safeParse({ ...remoteCleanup, disposition: 'retry' })),
    ).toContain(delayMismatch);
    expect(
      refusals(remoteResourceCleanupSchema.safeParse({ ...remoteCleanup, retryAfterSeconds: 30 })),
    ).toContain(delayMismatch);
    const parsed = remoteResourceCleanupSchema.parse(remoteCleanup);
    expect(remoteCleanupIdempotencyPreimage(parsed)).toBe(
      `verity.remote-cleanup.v1\0{"binding":{"id":"binding-1","provider":"doppler","version":1},"jobId":"job-1","resourceIdHash":"${hash}","resourceType":"remote-build"}`,
    );
    const sha256 = (value: string): string =>
      value.startsWith('verity.remote-cleanup.v1\0') ? hash : otherHash;
    expect(validateRemoteCleanupIdentity(remoteCleanup, sha256).cleanupId).toBe('cleanup-1');
    expect(() =>
      validateRemoteCleanupIdentity({ ...remoteCleanup, idempotencyKey: otherHash }, sha256),
    ).toThrow('cleanup idempotencyKey mismatch');
  });

  it('binds audit delivery to exactly one result reference', () => {
    const parse = (overrides: Record<string, unknown>): string[] =>
      refusals(completedSecretAuditRecordSchema.safeParse({ ...auditRecord, ...overrides }));
    const structured = '["delivery"] structured delivery requires only resultHash';
    expect(
      completedSecretAuditRecordSchema.parse({
        ...auditRecord,
        delivery: 'structured',
        resultHash: hash,
      }).delivery,
    ).toBe('structured');
    expect(parse({ delivery: 'structured' })).toContain(structured);
    expect(parse({ delivery: 'structured', resultHash: hash, artifactId: hash })).toContain(
      structured,
    );

    const artifact = '["delivery"] artifact delivery requires only artifactId';
    expect(
      completedSecretAuditRecordSchema.parse({
        ...auditRecord,
        delivery: 'artifact',
        artifactId: hash,
        effectiveMode: 'trusted',
      }).delivery,
    ).toBe('artifact');
    expect(parse({ delivery: 'artifact', effectiveMode: 'trusted' })).toContain(artifact);
    expect(
      parse({
        delivery: 'artifact',
        artifactId: hash,
        resultHash: hash,
        effectiveMode: 'trusted',
      }),
    ).toContain(artifact);

    const external = '["delivery"] external delivery forbids local result references';
    expect(parse({ resultHash: hash })).toContain(external);
    expect(parse({ artifactId: hash })).toContain(external);

    const none = '["delivery"] empty delivery forbids result references';
    expect(parse({ delivery: 'none', outcome: 'failed', resultHash: hash })).toContain(none);
    expect(parse({ delivery: 'none', outcome: 'failed', artifactId: hash })).toContain(none);
  });

  it('ties audit outcome to delivery and artifact delivery to trusted mode', () => {
    const parse = (overrides: Record<string, unknown>): string[] =>
      refusals(completedSecretAuditRecordSchema.safeParse({ ...auditRecord, ...overrides }));
    expect(
      completedSecretAuditRecordSchema.parse({
        ...auditRecord,
        delivery: 'none',
        outcome: 'failed',
      }).outcome,
    ).toBe('failed');
    const outcome = '["outcome"] outcome and delivery mismatch';
    expect(parse({ delivery: 'none' })).toContain(outcome);
    expect(parse({ outcome: 'failed' })).toContain(outcome);
    expect(parse({ delivery: 'artifact', artifactId: hash })).toContain(
      '["effectiveMode"] artifact audit requires trusted mode',
    );
  });
});
