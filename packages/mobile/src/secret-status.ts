import { z } from 'zod';

export const secretStatusSchema = z.object({
  status: z.enum(['unlocked', 'sealed', 'uninitialized', 'unmanaged']),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>['status'];
