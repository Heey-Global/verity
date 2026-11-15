import { z } from 'zod';

/** A restore probe as the server reports it. The server keeps no key in it.
 *  `status` and `phase` stay plain strings so a newer server's values do not
 *  make the whole backup status unreadable. */
export const backupProbeJobSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  phase: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  snapshot: z.unknown(),
  error: z.string().nullable(),
});
export type BackupProbeJob = z.infer<typeof backupProbeJobSchema>;

/** `GET /api/backups/status` (docs/BACKUP_API.md). `reason` stays a plain string:
 *  older servers report reasons this app does not know. */
export const backupStatusSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    configured: z.boolean(),
    paused: z.boolean().optional(),
    intervalMs: z.number().optional(),
    lastSuccess: z.number().nullable().optional(),
    capturing: z.boolean().optional(),
    keyGeneration: z.number().optional(),
    lastProbe: z.object({ finishedAt: z.number(), sequence: z.number() }).nullable().optional(),
    probe: backupProbeJobSchema.nullable().optional(),
    alerts: z.array(z.string()),
  }),
]);
export type BackupStatus = z.infer<typeof backupStatusSchema>;

/** A newly generated recovery key, shown once. It becomes active on confirmation. */
export const backupKeyOfferSchema = z.object({
  id: z.string().uuid(),
  recoveryKey: z.string().min(1),
  expiresAt: z.number(),
});
export type BackupKeyOffer = z.infer<typeof backupKeyOfferSchema>;
