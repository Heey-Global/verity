import { readFileSync } from 'node:fs';
import { z } from 'zod';

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime(),
  hostBootId: z.uuid().optional(),
  hostIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  roots: z.array(
    z.object({
      kind: z.enum(['buildkit', 'docker', 'containerd', 'export', 'project']),
      observedAt: z.iso.datetime().optional(),
      state: z.enum(['available', 'unavailable']),
      availableBytes: z.number().nonnegative().finite().optional(),
      freeInodes: z.number().nonnegative().finite().optional(),
      filesystemId: z.string().min(1).optional(),
    }),
  ),
});

export interface HostStorageEvidence {
  /** Lowest measured free bytes across the host roots, when any was measured. */
  availableBytes?: number;
  freeInodes?: number;
  /** Why a root was not measured; empty when every root was. */
  problems: string[];
}

const HOST_STORAGE_ROOTS = ['buildkit', 'docker', 'containerd', 'export', 'project'] as const;

/**
 * Reads the host storage report as measurements. A missing, stale or partial
 * report is not evidence of low space: admission then checks what was measured
 * and names the gaps, instead of refusing every build because a reporter or its
 * configuration is missing while the disks have room.
 */
export function readHostStorageEvidence(
  reportFile: string,
  now: number = Date.now(),
): HostStorageEvidence {
  let report: z.infer<typeof reportSchema>;
  try {
    const input = readFileSync(reportFile, 'utf8');
    if (input.length > 262144) return { problems: ['host storage report exceeds its size limit'] };
    report = reportSchema.parse(JSON.parse(input));
  } catch {
    return { problems: ['host storage report is missing or invalid'] };
  }
  const fresh = (observedAt: string | undefined) => {
    if (observedAt === undefined) return false;
    const age = now - Date.parse(observedAt);
    return age >= -5000 && age <= 120_000;
  };
  if (!fresh(report.observedAt)) return { problems: ['host storage report is stale'] };
  const evidence: HostStorageEvidence = { problems: [] };
  for (const kind of HOST_STORAGE_ROOTS) {
    const roots = report.roots.filter((root) => root.kind === kind);
    const root = roots[0];
    if (
      roots.length !== 1 ||
      root?.state !== 'available' ||
      root.availableBytes === undefined ||
      root.freeInodes === undefined ||
      root.filesystemId === undefined
    ) {
      evidence.problems.push(`${kind} filesystem is not established`);
      continue;
    }
    if (!fresh(root.observedAt)) {
      evidence.problems.push(`${kind} filesystem sample is stale or missing`);
      continue;
    }
    // Treat all roots as aliases for admission. Summing independent free
    // budgets would over-admit on the common single-host-filesystem layout.
    evidence.availableBytes = Math.min(evidence.availableBytes ?? Infinity, root.availableBytes);
    evidence.freeInodes = Math.min(evidence.freeInodes ?? Infinity, root.freeInodes);
  }
  return evidence;
}
