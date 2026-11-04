import { z } from 'zod';

const target = z.object({
  host: z.string().min(1),
  protocol: z.enum(['tcp', 'udp']),
  port: z.number().int().min(1).max(65535),
});
export const projectEgressRequestSchema = z.object({
  id: z.string().uuid(),
  target,
  revision: z.number().int().nonnegative(),
  requestedBy: z.array(z.string()),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(['pending', 'allowed', 'denied']),
  decidedBy: z.string().optional(),
  decidedAt: z.number().optional(),
});
export const projectEgressPolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  requests: z.record(z.string(), projectEgressRequestSchema),
  grants: z.array(
    z.object({
      id: z.string().uuid(),
      target,
      approvedBy: z.string(),
      approvedAt: z.number(),
      expiresAt: z.number().nullable(),
      revokedAt: z.number().optional(),
    }),
  ),
});
export type ProjectEgressPolicy = z.infer<typeof projectEgressPolicySchema>;
