import { z } from 'zod';

export const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});

/** `?fresh=1` asks for a forge read now instead of the cached pull request. */
export const branchReadQuery = z.object({ fresh: z.literal('1').optional().catch(undefined) });
