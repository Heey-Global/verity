import { z } from 'zod';
import {
  base64Schema,
  brokeredSecretsProtocolVersionSchema,
  isoUtcTimestampSchema,
  secretContractIdSchema,
  sha256HexSchema,
} from './common.js';
import { executionProfileRefSchema } from './catalog.js';
import { secretJobAttachmentStateSchema, secretJobStateSchema } from './grant.js';

const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MAX_REPLAY_PAGE_BYTES = 1_048_576;

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

function framePayloadBytes(encoding: 'utf8' | 'base64', payload: string): number {
  if (encoding === 'utf8') return utf8ByteLength(payload);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

export const executorProtocolHelloSchema = z
  .object({
    executorInstanceId: secretContractIdSchema,
    supportedProtocolVersions: z
      .array(brokeredSecretsProtocolVersionSchema)
      .min(1)
      .max(2)
      .refine((versions) => new Set(versions).size === versions.length, 'versions must be unique'),
    runtime: z.enum(['docker-gvisor', 'kubernetes-gvisor', 'firecracker']),
    runtimeVersion: z.string().min(1).max(128),
    imageDigest: sha256HexSchema,
  })
  .strict();
export type ExecutorProtocolHello = z.infer<typeof executorProtocolHelloSchema>;

export const secretJobStartRequestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    requestId: secretContractIdSchema,
    projectId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    jobId: secretContractIdSchema,
    grantId: secretContractIdSchema,
    profile: executionProfileRefSchema,
    snapshotId: sha256HexSchema.optional(),
    executorImageDigest: sha256HexSchema,
    absoluteDeadline: isoUtcTimestampSchema,
  })
  .strict();
export type SecretJobStartRequest = z.infer<typeof secretJobStartRequestSchema>;

export const secretJobStartResponseSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    requestId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    jobId: secretContractIdSchema,
    disposition: z.enum(['created', 'existing']),
    state: z.enum(['pending', 'running']),
    executorInstanceId: secretContractIdSchema,
    acceptedAt: isoUtcTimestampSchema,
  })
  .strict();
export type SecretJobStartResponse = z.infer<typeof secretJobStartResponseSchema>;

export const secretJobAttachRequestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    nextSequence: sequenceSchema,
    maxFrames: z.number().int().positive().max(256),
    maxBytes: z.number().int().positive().max(MAX_REPLAY_PAGE_BYTES),
  })
  .strict();
export type SecretJobAttachRequest = z.infer<typeof secretJobAttachRequestSchema>;

export const secretJobFrameSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    sequence: sequenceSchema,
    stream: z.enum(['stdout', 'stderr', 'system']),
    encoding: z.enum(['utf8', 'base64']),
    payload: z.string().max(87_384),
    emittedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((frame, ctx) => {
    if (frame.encoding === 'base64' && !base64Schema.safeParse(frame.payload).success) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'invalid base64 frame payload' });
    }
    const bytes = framePayloadBytes(frame.encoding, frame.payload);
    if (bytes > 65_536) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'frame exceeds 65536 bytes' });
    }
  });
export type SecretJobFrame = z.infer<typeof secretJobFrameSchema>;

export const secretJobAttachResponseSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    firstSequence: sequenceSchema.optional(),
    nextSequence: sequenceSchema,
    frames: z.array(secretJobFrameSchema).max(256),
    hasMore: z.boolean(),
    state: secretJobStateSchema,
    attachmentState: secretJobAttachmentStateSchema,
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.frames.length === 0 && response.firstSequence !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstSequence'],
        message: 'empty replay forbids firstSequence',
      });
    }
    if (response.frames.length > 0 && response.firstSequence === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstSequence'],
        message: 'replay frames require firstSequence',
      });
    }
    for (const [index, frame] of response.frames.entries()) {
      const expected = (response.firstSequence ?? frame.sequence) + index;
      if (frame.jobId !== response.jobId || frame.sequence !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['frames', index],
          message: 'non-contiguous or foreign frame',
        });
      }
    }
    if (
      response.frames.length > 0 &&
      response.nextSequence !== response.frames.at(-1)!.sequence + 1
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextSequence'],
        message: 'nextSequence must follow replay',
      });
    }
    const replayBytes = response.frames.reduce(
      (total, frame) => total + framePayloadBytes(frame.encoding, frame.payload),
      0,
    );
    if (replayBytes > MAX_REPLAY_PAGE_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['frames'],
        message: `replay page exceeds ${MAX_REPLAY_PAGE_BYTES} bytes`,
      });
    }
  });
export type SecretJobAttachResponse = z.infer<typeof secretJobAttachResponseSchema>;

/** Contextual validator that binds a replay page to the cursor and limits requested by its caller. */
export const secretJobAttachExchangeSchema = z
  .object({ request: secretJobAttachRequestSchema, response: secretJobAttachResponseSchema })
  .strict()
  .superRefine((exchange, ctx) => {
    if (exchange.response.jobId !== exchange.request.jobId) {
      ctx.addIssue({ code: 'custom', path: ['response', 'jobId'], message: 'attach job mismatch' });
    }
    if (
      exchange.response.frames.length > 0 &&
      exchange.response.firstSequence !== exchange.request.nextSequence
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'firstSequence'],
        message: 'replay must begin at requested nextSequence',
      });
    }
    if (
      exchange.response.frames.length === 0 &&
      exchange.response.nextSequence !== exchange.request.nextSequence
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'nextSequence'],
        message: 'empty replay must preserve requested nextSequence',
      });
    }
    if (exchange.response.frames.length > exchange.request.maxFrames) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'frames'],
        message: 'replay exceeds requested maxFrames',
      });
    }
    const replayBytes = exchange.response.frames.reduce(
      (total, frame) => total + framePayloadBytes(frame.encoding, frame.payload),
      0,
    );
    if (replayBytes > exchange.request.maxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'frames'],
        message: 'replay exceeds requested maxBytes',
      });
    }
  });
export type SecretJobAttachExchange = z.infer<typeof secretJobAttachExchangeSchema>;

const allowedJobTransitions: Readonly<
  Record<z.infer<typeof secretJobStateSchema>, readonly string[]>
> = {
  pending: ['running', 'cancelling', 'terminal'],
  running: ['cancelling', 'terminal'],
  cancelling: ['terminal'],
  terminal: ['reaping'],
  reaping: ['reaped'],
  reaped: [],
};

export const secretJobTransitionSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    from: secretJobStateSchema,
    to: secretJobStateSchema,
    transitionId: secretContractIdSchema,
    observedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((transition, ctx) => {
    if (!allowedJobTransitions[transition.from].includes(transition.to)) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `invalid job transition: ${transition.from} -> ${transition.to}`,
      });
    }
  });
export type SecretJobTransition = z.infer<typeof secretJobTransitionSchema>;

export const secretJobCancelRequestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    cancellationId: secretContractIdSchema,
    reason: z.enum(['user', 'deadline', 'policy', 'shutdown', 'reaper']),
  })
  .strict();
export type SecretJobCancelRequest = z.infer<typeof secretJobCancelRequestSchema>;

export const secretJobStatusSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    requestId: secretContractIdSchema,
    requestHash: sha256HexSchema,
    state: secretJobStateSchema,
    attachmentState: secretJobAttachmentStateSchema,
    lastSequence: sequenceSchema.optional(),
    absoluteDeadline: isoUtcTimestampSchema,
    updatedAt: isoUtcTimestampSchema,
    terminalReason: z.string().min(1).max(256).optional(),
    cleanupAttempts: z.number().int().nonnegative().max(100),
  })
  .strict();
export type SecretJobStatus = z.infer<typeof secretJobStatusSchema>;

export const secretJobTerminalResultSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'deadline_exceeded']),
    exitCode: z.number().int().min(0).max(255).optional(),
    validatedResultRef: secretContractIdSchema.optional(),
    resultHash: sha256HexSchema.optional(),
    finalSequence: sequenceSchema.optional(),
    finishedAt: isoUtcTimestampSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if ((result.validatedResultRef === undefined) !== (result.resultHash === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validatedResultRef'],
        message: 'validated result reference and hash must appear together',
      });
    }
  });
export type SecretJobTerminalResult = z.infer<typeof secretJobTerminalResultSchema>;

export const secretJobCleanupRequestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    cleanupId: secretContractIdSchema,
  })
  .strict();
export type SecretJobCleanupRequest = z.infer<typeof secretJobCleanupRequestSchema>;

export const secretJobCleanupResponseSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    cleanupId: secretContractIdSchema,
    disposition: z.enum(['reaped', 'already_reaped', 'retry']),
    retryAfterSeconds: z.number().int().positive().max(3_600).optional(),
    completedAt: isoUtcTimestampSchema.optional(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if ((response.disposition === 'retry') !== (response.retryAfterSeconds !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['retryAfterSeconds'],
        message: 'retry requires retryAfterSeconds',
      });
    }
    if ((response.disposition !== 'retry') !== (response.completedAt !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'completed cleanup requires completedAt',
      });
    }
  });
export type SecretJobCleanupResponse = z.infer<typeof secretJobCleanupResponseSchema>;
