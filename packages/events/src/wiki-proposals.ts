import { z } from 'zod';

/**
 * Proposed Wiki changes as the review routes return them. Page paths are
 * relative to the Wiki (`insights/`), as agents name them.
 */
const changeStatusSchema = z.enum(['pending', 'applied', 'rejected']);

const proposalHeadSchema = z.object({
  id: z.string(),
  mode: z.enum(['inline', 'maintenance']),
  /** The kind of the log.md entry applying writes (`chat`, `ingest`, …). */
  logKind: z.string(),
  title: z.string(),
  /** Knowledge paths or web addresses the proposal rests on. */
  sources: z.array(z.string()),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

const proposalChangeSummarySchema = z.object({
  path: z.string(),
  summary: z.string(),
  status: changeStatusSchema,
  /** The page changed since the proposal; applying would be refused. */
  stale: z.boolean(),
});

export const wikiProposalListSchema = z.object({
  proposals: z.array(proposalHeadSchema.extend({ changes: z.array(proposalChangeSummarySchema) })),
});

export const wikiProposalSchema = proposalHeadSchema.extend({
  changes: z.array(
    proposalChangeSummarySchema.extend({
      /** The proposed page; null once decided. */
      content: z.string().nullable(),
      /** The page as it is now; null when it does not exist yet or is decided. */
      current: z.string().nullable(),
    }),
  ),
});

export const wikiProposalDecisionSchema = z.object({
  applied: z.array(z.string()),
  stale: z.array(z.string()),
  failed: z.array(z.string()).optional().default([]),
  /** Set when the pages were applied but log.md could not be updated. */
  warning: z.string().optional(),
});

export type WikiProposalSummary = z.infer<typeof wikiProposalListSchema>['proposals'][number];
export type WikiProposal = z.infer<typeof wikiProposalSchema>;
export type WikiProposalDecision = z.infer<typeof wikiProposalDecisionSchema>;
