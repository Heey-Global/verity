import { knowledgeToolRequestSchema } from '@verity/events';

export const KNOWLEDGE_PUBLISH_EXPLANATION =
  'Copies this project insight into Global Knowledge, where agents in every project on this Verity instance can read and use it. The project original stays in place. Approving permits this publication only.';

export function knowledgePublishSummary(input: unknown): {
  source: string;
  destination: string;
  replacesExisting: boolean;
} | null {
  const parsed = knowledgeToolRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.operation !== 'publish_shared') return null;
  return {
    source: `/knowledge/insights/${parsed.data.path}`,
    destination: `/knowledge/shared/insights/${parsed.data.sharedPath ?? parsed.data.path}`,
    replacesExisting: parsed.data.expectedDigest !== undefined,
  };
}
