import { z } from 'zod';
import { secretContractIdSchema, sha256HexSchema } from './common.js';

export const REDACTOR_REPLACEMENT = new Uint8Array([91, 82, 69, 68, 65, 67, 84, 69, 68, 93]);

export const streamingRedactorProfileSchema = z
  .object({
    id: secretContractIdSchema,
    version: z.number().int().positive(),
    implementationDigest: sha256HexSchema,
    algorithm: z.literal('byte-longest-first-v1'),
    minimumSecretBytes: z.literal(4),
    maximumSecretBytes: z.number().int().min(4).max(4096),
    maximumActiveSecrets: z.number().int().positive().max(64),
    maximumInputChunkBytes: z.number().int().positive().max(65_536),
    maximumScanComparisons: z.number().int().positive().max(8_388_608),
    maximumOutputBytes: z.number().int().positive().max(67_108_864),
    replacement: z.literal('[REDACTED]'),
  })
  .strict();
export type StreamingRedactorProfile = z.infer<typeof streamingRedactorProfileSchema>;

export const redactorTerminalReasonSchema = z.enum([
  'completed',
  'cancelled',
  'input_limit',
  'output_limit',
  'work_limit',
  'redaction_collision',
  'downstream_failure',
  'executor_failure',
]);
export type RedactorTerminalReason = z.infer<typeof redactorTerminalReasonSchema>;

export const redactorPersistenceReceiptSchema = z
  .object({
    jobId: secretContractIdSchema,
    redactorId: secretContractIdSchema,
    redactorVersion: z.number().int().positive(),
    firstSequence: z.number().int().nonnegative(),
    nextSequence: z.number().int().positive(),
    persistedFrameCount: z.number().int().positive().max(256),
    persistedBytes: z.number().int().nonnegative().max(1_048_576),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.nextSequence !== receipt.firstSequence + receipt.persistedFrameCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextSequence'],
        message: 'persisted sequence range does not match frame count',
      });
    }
  });
export type RedactorPersistenceReceipt = z.infer<typeof redactorPersistenceReceiptSchema>;

export class RedactionLimitError extends Error {
  constructor(readonly reason: 'input_limit' | 'output_limit' | 'work_limit') {
    super(`streaming redactor ${reason.replace('_', ' ')} exceeded`);
    this.name = 'RedactionLimitError';
  }
}

export class RedactionCollisionError extends Error {
  constructor() {
    super('streaming redactor output collision');
    this.name = 'RedactionCollisionError';
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

type ScanBudget = { remaining: number };

function startsWithAt(
  input: Uint8Array,
  secret: Uint8Array,
  offset: number,
  budget?: ScanBudget,
): boolean {
  if (offset + secret.length > input.length) return false;
  for (let index = 0; index < secret.length; index += 1) {
    if (budget !== undefined && --budget.remaining < 0) {
      throw new RedactionLimitError('work_limit');
    }
    if (input[offset + index] !== secret[index]) return false;
  }
  return true;
}

function containsBytes(input: Uint8Array, secret: Uint8Array, budget: ScanBudget): boolean {
  for (let offset = 0; offset + secret.length <= input.length; offset += 1) {
    if (startsWithAt(input, secret, offset, budget)) return true;
  }
  return false;
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

/**
 * Protocol-v1 reference redactor. It is binary-safe and retains at most maximumSecretBytes - 1
 * unredacted bytes inside the Executor. Returned bytes are safe to frame; input bytes never are.
 */
export class StreamingSecretRedactor {
  readonly #profile: StreamingRedactorProfile;
  readonly #secrets: Uint8Array[];
  #pending = new Uint8Array(0);
  #outputPending = new Uint8Array(0);
  #outputBytes = 0;
  #terminal = false;

  constructor(profile: StreamingRedactorProfile, secrets: readonly Uint8Array[]) {
    this.#profile = streamingRedactorProfileSchema.parse(profile);
    if (secrets.length === 0 || secrets.length > profile.maximumActiveSecrets) {
      throw new RangeError('active secret count outside profile limits');
    }
    const unique = new Map<string, Uint8Array>();
    for (const secret of secrets) {
      if (
        secret.length < profile.minimumSecretBytes ||
        secret.length > profile.maximumSecretBytes
      ) {
        throw new RangeError('secret length outside profile limits');
      }
      const key = Array.from(secret).join(',');
      unique.set(key, new Uint8Array(secret));
    }
    this.#secrets = [...unique.values()].sort(
      (left, right) => right.length - left.length || compareBytes(left, right),
    );
  }

  push(chunk: Uint8Array): Uint8Array {
    this.#assertActive();
    if (chunk.length > this.#profile.maximumInputChunkBytes) {
      this.#terminate();
      throw new RedactionLimitError('input_limit');
    }
    const input = join(this.#pending, chunk);
    const retain = Math.min(this.#profile.maximumSecretBytes - 1, input.length);
    return this.#withWorkBudget(() => this.#transform(input, input.length - retain));
  }

  flush(): Uint8Array {
    this.#assertActive();
    const output = this.#withWorkBudget(() =>
      this.#transform(this.#pending, this.#pending.length, true),
    );
    this.#terminate();
    return output;
  }

  abort(): void {
    this.#terminate();
  }

  /**
   * Explicit, idempotent cleanup. Zeroizes the redactor's private copies of the active secrets and
   * marks the instance terminal, so plaintext secret bytes do not linger in redactor-held memory
   * after a job returns. Safe to call at any time, including when already terminal.
   */
  dispose(): void {
    this.#terminate();
  }

  /** Mark terminal and best-effort zeroize every secret-bearing buffer before detaching it. */
  #terminate(): void {
    // Wipe before dropping: #pending can hold up to maximumSecretBytes-1 raw, unredacted secret
    // fragments, and #outputPending holds retained output — zero them so no plaintext lingers in
    // the detached buffers, then zeroize the private secret copies.
    this.#pending.fill(0);
    this.#outputPending.fill(0);
    this.#pending = new Uint8Array(0);
    this.#outputPending = new Uint8Array(0);
    this.#terminal = true;
    for (const secret of this.#secrets) secret.fill(0);
  }

  #transform(
    input: Uint8Array,
    emitBefore: number,
    flushing = false,
    budget = this.#activeBudget,
  ): Uint8Array {
    const output: number[] = [];
    let offset = 0;
    while (offset < emitBefore) {
      const match = this.#secrets.find((secret) => startsWithAt(input, secret, offset, budget));
      if (match !== undefined) {
        output.push(...REDACTOR_REPLACEMENT);
        offset += match.length;
      } else {
        output.push(input[offset]!);
        offset += 1;
      }
    }
    this.#pending = flushing ? new Uint8Array(0) : input.slice(offset);
    return this.#stageOutput(new Uint8Array(output), flushing, budget);
  }

  #activeBudget: ScanBudget = { remaining: 0 };

  #stageOutput(candidate: Uint8Array, flushing: boolean, budget: ScanBudget): Uint8Array {
    const combined = join(this.#outputPending, candidate);
    if (this.#secrets.some((secret) => containsBytes(combined, secret, budget))) {
      this.#terminate();
      throw new RedactionCollisionError();
    }
    const retain = flushing ? 0 : Math.min(this.#profile.maximumSecretBytes - 1, combined.length);
    const emitted = combined.slice(0, combined.length - retain);
    this.#outputPending = combined.slice(combined.length - retain);
    if (this.#outputBytes + emitted.length > this.#profile.maximumOutputBytes) {
      this.#terminate();
      throw new RedactionLimitError('output_limit');
    }
    this.#outputBytes += emitted.length;
    return emitted;
  }

  #assertActive(): void {
    if (this.#terminal) throw new Error('streaming redactor is terminal');
  }

  #withWorkBudget<T>(operation: () => T): T {
    this.#activeBudget = { remaining: this.#profile.maximumScanComparisons };
    try {
      return operation();
    } catch (error) {
      if (error instanceof RedactionLimitError && error.reason === 'work_limit') {
        this.#terminate();
      }
      throw error;
    }
  }
}
