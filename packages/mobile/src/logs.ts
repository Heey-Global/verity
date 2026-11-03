import { z } from 'zod';

/** A local diagnostic selection is never consent to send a support report. */
export const buildDiagnosticResponseSchema = z.object({
  provenance: z.object({
    source: z.literal('build'),
    operationId: z.string(),
    supportConsent: z.literal('required'),
  }),
  state: z.enum(['available', 'pending', 'expired', 'unavailable', 'failed']),
  diagnostic: z
    .object({
      operationId: z.string(),
      recordedAt: z.string(),
      phase: z.literal('image_build'),
      code: z.literal('build_failed'),
      text: z.string(),
      truncated: z.boolean(),
    })
    .nullable(),
});

export const systemLogResponseSchema = z.object({
  source: z.enum(['server', 'host']),
  window: z.object({ since: z.string(), until: z.string() }),
  supportConsent: z.literal('required'),
  state: z.enum(['available', 'unavailable', 'failed']),
  reason: z
    .enum([
      'not_configured',
      'container_not_found',
      'access_denied',
      'docker_unreachable',
      'read_failed',
    ])
    .optional(),
  stale: z.boolean(),
  truncated: z.boolean(),
  observedAt: z.string().nullable().optional(),
  sourceWindow: z.object({ since: z.string(), until: z.string() }).nullable().optional(),
  sources: z
    .object({ kernel: z.string(), runtime: z.string(), docker: z.string().optional() })
    .nullable()
    .optional(),
  entries: z.array(
    z.object({
      at: z.string().nullable(),
      level: z.string().nullable(),
      text: z.string(),
      source: z.string().optional(),
      code: z.string().optional(),
      exitCode: z.number().optional(),
    }),
  ),
});
