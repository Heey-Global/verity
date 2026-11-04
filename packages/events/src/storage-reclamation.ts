import { z } from 'zod';
const bytes = z.number().finite().nonnegative();
export const nativeRetirementSchema = z.object({
  version: z.literal(1),
  observedAt: z.iso.datetime({ offset: true }),
  path: z.string().max(500),
  dryRun: z.boolean(),
  eligible: z.boolean(),
  state: z.enum(['deferred', 'blocked', 'absent', 'completed']).optional(),
  allocatedBytes: bytes.nullable(),
  overlayAllocatedBytes: bytes.nullable(),
  reclaimableBytes: bytes.nullable(),
  filesystemFreedBytes: bytes.nullable().optional(),
  lastCompletedAt: z.iso.datetime({ offset: true }).optional(),
  blockers: z.array(z.string().max(200)).max(100),
});
/** Cache allocation measurements are separate from the host filesystem free-space delta. */
export const runnerCacheReclamationSchema = z.object({
  observedAt: z.iso.datetime({ offset: true }),
  sharedBytes: bytes.nullable(),
  legacyBytes: bytes.nullable(),
  removedBytes: bytes,
  legacyCachesRemoved: z.number().int().nonnegative(),
  sharedCachesPruned: z.number().int().nonnegative(),
  usageComplete: z.boolean(),
  blockers: z.array(z.string().max(500)).max(100),
});
export type RunnerCacheReclamationReport = z.infer<typeof runnerCacheReclamationSchema>;

export const storageReclamationActionSchema = z.object({
  supported: z.boolean(),
  state: z.enum(['idle', 'running', 'completed', 'failed']),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  result: z
    .object({
      imagesRemoved: bytes,
      containersRemoved: bytes,
      dependenciesRemoved: bytes,
      worktreesRetired: bytes,
      runnerCaches: runnerCacheReclamationSchema.nullable().optional(),
      filesystemFreeBytesChange: z.number().finite().nullable(),
      retainedPins: z.array(
        z.object({ imageId: z.string(), containers: z.array(z.string()), reason: z.string() }),
      ),
      blockers: z.array(z.string()),
    })
    .nullable(),
  nativePending: z.boolean(),
  nativeBuildkit: nativeRetirementSchema.nullable(),
});
export type StorageReclamationAction = z.infer<typeof storageReclamationActionSchema>;
