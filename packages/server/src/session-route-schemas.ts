import { z } from 'zod';

export const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});
