import { z } from 'zod';

const managedServerProviderSourceSchema = z
  .object({
    project: z.string().min(1).max(200),
    config: z.string().min(1).max(200),
    connectionId: z.string().min(1).max(200),
    connectionLabel: z.string().min(1).max(80).optional(),
    workplaceSlug: z.string().min(1).max(200).optional(),
  })
  .strict();

export const managedServerProviderSnapshotSchema = z.object({
  provider: z.literal('doppler'),
  project: z.string().min(1),
  config: z.string().min(1),
  authority: z.string().optional(),
  sources: z.array(managedServerProviderSourceSchema).min(1).max(16).optional(),
});

export type ManagedServerProviderSnapshot = z.infer<typeof managedServerProviderSnapshotSchema>;
