import { z } from 'zod';
import {
  base64Schema,
  brokeredSecretsProtocolVersionSchema,
  isoUtcTimestampSchema,
  secretContractIdSchema,
  sha256HexSchema,
} from './common.js';
import {
  executionProfileRefSchema,
  providerBindingRefSchema,
  secretAliasRefSchema,
} from './catalog.js';

export const approvalRefSchema = z
  .object({
    id: secretContractIdSchema,
    actorId: secretContractIdSchema,
    decisionHash: sha256HexSchema,
  })
  .strict();
export type ApprovalRef = z.infer<typeof approvalRefSchema>;

export const approvalRecordSchema = z
  .object({
    id: secretContractIdSchema,
    projectId: secretContractIdSchema,
    sessionId: secretContractIdSchema,
    toolCallId: secretContractIdSchema,
    actorId: secretContractIdSchema,
    decision: z.enum(['approved', 'denied']),
    decisionHash: sha256HexSchema,
    decidedAt: isoUtcTimestampSchema,
  })
  .strict();
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

/** Claims to sign for a single-use run grant. No secret value or source key is present. */
export const runGrantClaimsSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    grantId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    projectId: secretContractIdSchema,
    sessionId: secretContractIdSchema,
    turnId: secretContractIdSchema,
    toolCallId: secretContractIdSchema,
    profile: executionProfileRefSchema,
    /** Immutable executor image selected when the approval request is created. */
    executorImageDigest: sha256HexSchema.optional(),
    aliases: z.array(secretAliasRefSchema).max(16),
    providerBindings: z.array(providerBindingRefSchema).max(16),
    snapshotId: sha256HexSchema.optional(),
    approval: approvalRefSchema.optional(),
    audience: z.literal('verity-secret-job-executor'),
    issuedAt: isoUtcTimestampSchema,
    expiresAt: isoUtcTimestampSchema,
    nonce: z.string().min(32).max(256),
  })
  .strict()
  .superRefine((grant, ctx) => {
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'grant must expire after issue',
      });
    }
    const aliases = new Set(grant.aliases.map((alias) => `${alias.id}:${alias.version}`));
    if (aliases.size !== grant.aliases.length) {
      ctx.addIssue({ code: 'custom', path: ['aliases'], message: 'grant aliases must be unique' });
    }
    const providerBindings = new Set(
      grant.providerBindings.map((binding) => `${binding.id}:${binding.version}`),
    );
    if (providerBindings.size !== grant.providerBindings.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerBindings'],
        message: 'grant provider bindings must be unique',
      });
    }
  });
export type RunGrantClaims = z.infer<typeof runGrantClaimsSchema>;

export const executorWorkloadIdentitySchema = z
  .object({
    executorInstanceId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    publicKeyId: secretContractIdSchema,
    attestationHash: sha256HexSchema,
  })
  .strict();
export type ExecutorWorkloadIdentity = z.infer<typeof executorWorkloadIdentitySchema>;

const base64Bytes = (bytes: number) =>
  base64Schema.refine((value) => {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return (value.length / 4) * 3 - padding === bytes;
  }, `must decode to exactly ${bytes} bytes`);

/**
 * Provisional Phase 0 envelope shape. The cipher suite, AAD encoding, HKDF context, tag layout,
 * and payload schema are not production-ready until W5 freezes them with golden vectors.
 */
export const secretEnvelopeSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    envelopeId: secretContractIdSchema,
    grantId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    recipientKeyId: secretContractIdSchema,
    algorithm: z.literal('x25519-hkdf-sha256-aes-256-gcm'),
    ephemeralPublicKey: base64Bytes(32),
    nonce: base64Bytes(12),
    aadHash: sha256HexSchema,
    ciphertext: base64Schema.min(1).max(1_048_576),
    expiresAt: isoUtcTimestampSchema,
  })
  .strict();
export type SecretEnvelope = z.infer<typeof secretEnvelopeSchema>;

export const runGrantRedemptionSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    grantId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    workload: executorWorkloadIdentitySchema,
  })
  .strict()
  .superRefine((redemption, ctx) => {
    if (redemption.jobId !== redemption.workload.jobId) {
      ctx.addIssue({
        code: 'custom',
        path: ['workload', 'jobId'],
        message: 'job identity mismatch',
      });
    }
  });
export type RunGrantRedemption = z.infer<typeof runGrantRedemptionSchema>;

export const secretJobStateSchema = z.enum([
  'pending',
  'running',
  'cancelling',
  'terminal',
  'reaping',
  'reaped',
]);
export type SecretJobState = z.infer<typeof secretJobStateSchema>;

export const secretJobAttachmentStateSchema = z.enum(['attached', 'detached']);
export type SecretJobAttachmentState = z.infer<typeof secretJobAttachmentStateSchema>;

export const secretJobRecordSchema = z
  .object({
    id: secretContractIdSchema,
    projectId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    grantId: secretContractIdSchema,
    profile: executionProfileRefSchema,
    snapshotId: sha256HexSchema.optional(),
    executorInstanceId: secretContractIdSchema.optional(),
    state: secretJobStateSchema,
    attachmentState: secretJobAttachmentStateSchema,
    createdAt: isoUtcTimestampSchema,
    absoluteDeadline: isoUtcTimestampSchema,
    terminalReason: z.string().min(1).max(256).optional(),
  })
  .strict();
export type SecretJobRecord = z.infer<typeof secretJobRecordSchema>;

/** Safe audit projection. Raw argv, provider keys, ciphertext, and secret values are absent. */
export const secretAuditRecordSchema = z
  .object({
    id: secretContractIdSchema,
    projectId: secretContractIdSchema,
    sessionId: secretContractIdSchema,
    toolCallId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    aliases: z.array(secretAliasRefSchema).max(16),
    providerBindings: z.array(providerBindingRefSchema).max(16),
    profile: executionProfileRefSchema,
    snapshotId: sha256HexSchema.optional(),
    imageDigest: sha256HexSchema.optional(),
    executableDigest: sha256HexSchema.optional(),
    approvalId: secretContractIdSchema.optional(),
    redactorVersion: secretContractIdSchema,
    outcome: z.enum(['denied', 'failed', 'cancelled', 'succeeded']),
    cleanupState: z.enum(['not_started', 'pending', 'complete', 'attention']),
    recordedAt: isoUtcTimestampSchema,
  })
  .strict();
export type SecretAuditRecord = z.infer<typeof secretAuditRecordSchema>;
