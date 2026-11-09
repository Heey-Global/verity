import { z } from 'zod';

export const protectedBuildReason = z.enum([
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
]);
export const protectedBuildDiagnostic = z.object({
  reason: protectedBuildReason,
  correlationId: z.uuid().optional(),
});
export type ProtectedBuildDiagnostic = z.infer<typeof protectedBuildDiagnostic>;

/** Only these fixed fields may cross from host failures into project build output. */
export class ProtectedBuildFailure extends Error {
  constructor(
    readonly reason: ProtectedBuildDiagnostic['reason'],
    options?: ErrorOptions & { correlationId?: string | undefined },
  ) {
    super(
      `Protected builder refused the operation (${reason}${options?.correlationId ? `; reference ${options.correlationId}` : ''})`,
      options,
    );
    this.correlationId = options?.correlationId;
  }
  readonly correlationId: string | undefined;
}
export function protectedBuildFailure(error: unknown): ProtectedBuildDiagnostic {
  if (error instanceof ProtectedBuildFailure) {
    const parsed = protectedBuildDiagnostic.safeParse(error);
    if (parsed.success) return parsed.data;
  }
  return { reason: 'operation_refused' };
}
