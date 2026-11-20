import { z } from 'zod';

const protectedBuildReason = z.enum([
  'operation_refused',
  'prepare_failed',
  'network_prepare_failed',
  'authority_prepare_failed',
  'files_prepare_failed',
  'renew_failed',
  'launch_failed',
  'cleanup_failed',
  'containment_failed',
  'slot_busy',
  'attempt_changed',
  'unknown_attempt',
  'address_pool_exhausted',
]);
/** Fixed host step that refused packet authority for a new build attempt. Only
 * this class name crosses to the Server and UI; the message stays in the host
 * journal under the correlation id. */
export const protectedBuildAuthorityStep = z.enum([
  // Root-owned inspection record for the anchor namespace could not be written.
  'inspection_record',
  // Docker or the bridge device no longer matches the anchor that was created.
  'attachment',
  // The nft build table could not be installed.
  'fence_rules',
  // The root deadline helper could not attach its packet guard.
  'packet_guard',
  // The root deadline helper refused to revoke the guard.
  'packet_revoke',
]);
export type ProtectedBuildAuthorityStep = z.infer<typeof protectedBuildAuthorityStep>;
export const protectedBuildDiagnostic = z.object({
  reason: protectedBuildReason,
  detail: protectedBuildAuthorityStep.optional(),
  correlationId: z.uuid().optional(),
});
export type ProtectedBuildDiagnostic = z.infer<typeof protectedBuildDiagnostic>;

/** Only these fixed fields may cross from host failures into project build output. */
export class ProtectedBuildFailure extends Error {
  constructor(
    readonly reason: ProtectedBuildDiagnostic['reason'],
    options?: ErrorOptions & {
      correlationId?: string | undefined;
      detail?: ProtectedBuildAuthorityStep | undefined;
    },
  ) {
    super(
      `Protected builder refused the operation (${reason}${options?.detail ? `: ${options.detail}` : ''}${options?.correlationId ? `; reference ${options.correlationId}` : ''})`,
      options,
    );
    this.correlationId = options?.correlationId;
    this.detail = options?.detail;
  }
  readonly correlationId: string | undefined;
  readonly detail: ProtectedBuildAuthorityStep | undefined;
}

/** Names the packet-authority step that failed; see protectedBuildAuthorityStep. */
export class ProtectedBuildAuthorityError extends Error {
  constructor(
    readonly step: ProtectedBuildAuthorityStep,
    options: ErrorOptions,
  ) {
    super(`Protected build authority ${step} failed`, options);
    this.name = 'ProtectedBuildAuthorityError';
  }
}
/** Run one authority step, classifying its failure unless an inner step already did. */
export async function protectedBuildAuthorityStepRun<T>(
  step: ProtectedBuildAuthorityStep,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ProtectedBuildAuthorityError) throw cause;
    throw new ProtectedBuildAuthorityError(step, { cause });
  }
}
/** First classified authority step in a cause chain, including aggregated causes. */
export function protectedBuildAuthorityFailureStep(
  error: unknown,
): ProtectedBuildAuthorityStep | undefined {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length && seen.size < 32) {
    const current = queue.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ProtectedBuildAuthorityError) return current.step;
    if (current instanceof AggregateError) queue.push(...(current.errors as unknown[]));
    queue.push(current.cause);
  }
  return undefined;
}
export function protectedBuildFailure(error: unknown): ProtectedBuildDiagnostic {
  if (error instanceof ProtectedBuildFailure) {
    const parsed = protectedBuildDiagnostic.safeParse(error);
    if (parsed.success) return parsed.data;
  }
  return { reason: 'operation_refused' };
}

/** Names the host step that failed, so a retried cleanup can be correlated with
 * its attempt and the exact operation instead of a bare transaction error. */
export class ProtectedBuildStageError extends Error {
  constructor(
    readonly stage: string,
    options: ErrorOptions,
  ) {
    super(`Protected build ${stage} failed`, options);
    this.name = 'ProtectedBuildStageError';
  }
}

export interface ProtectedBuildFailureDescription {
  stage?: string;
  /** First line of each error in the cause chain, bounded in count and length. */
  causes: string[];
  /** Structured evidence attached to a cause, such as a failed nft transaction. */
  evidence: unknown[];
}

/** Host-journal description of a failure. Only first message lines and evidence
 * objects that their producer already bounded and sanitised are included. */
export function describeProtectedBuildFailure(error: unknown): ProtectedBuildFailureDescription {
  const description: ProtectedBuildFailureDescription = { causes: [], evidence: [] };
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length && description.causes.length < 8) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    if (!(current instanceof Error)) {
      description.causes.push(
        typeof current === 'string' ? current.split('\n')[0]!.slice(0, 300) : typeof current,
      );
      continue;
    }
    if (current instanceof ProtectedBuildStageError) description.stage ??= current.stage;
    description.causes.push(
      `${current.name}: ${current.message.split('\n')[0]!.slice(0, 300)}`.replace(
        /[^\x20-\x7e‘’]/gu,
        '?',
      ),
    );
    if ('evidence' in current && typeof current.evidence === 'object' && current.evidence !== null)
      description.evidence.push(current.evidence);
    if (current instanceof AggregateError) queue.push(...(current.errors as unknown[]));
    queue.push(current.cause);
  }
  return description;
}
