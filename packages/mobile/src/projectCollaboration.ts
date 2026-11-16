import { z } from 'zod';

export const projectRepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  kind: z.enum(['github', 'forgejo', 'local', 'control_plane']),
  owner: z.string(),
  repo: z.string(),
  forgeConnectionId: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  isDefault: z.boolean(),
  removedAt: z.string().nullable(),
});
export type ProjectRepository = z.infer<typeof projectRepositorySchema>;

const repositoryInstructionsBase = {
  id: z.string(),
  name: z.string(),
  kind: z.enum(['github', 'forgejo']),
  owner: z.string(),
  repo: z.string(),
  isDefault: z.boolean(),
  path: z.literal('AGENTS.md'),
};

/** A connected repository's root AGENTS.md. "unavailable" means it could not be
 *  checked, which is not the same as the repository having no file. */
export const repositoryInstructionsSchema = z.discriminatedUnion('status', [
  z.object({
    ...repositoryInstructionsBase,
    status: z.literal('present'),
    branch: z.string(),
    instructions: z.string(),
    revision: z.string(),
    truncated: z.boolean(),
  }),
  z.object({ ...repositoryInstructionsBase, status: z.literal('missing'), branch: z.string() }),
  z.object({
    ...repositoryInstructionsBase,
    status: z.literal('unavailable'),
    branch: z.string().nullable(),
  }),
]);
export type RepositoryInstructions = z.infer<typeof repositoryInstructionsSchema>;

export const projectInquirySchema = z.object({
  id: z.string(),
  sourceSessionId: z.string(),
  targetSessionId: z.string(),
  sourceProjectId: z.string(),
  targetProjectId: z.string(),
  sourceProjectName: z.string().optional(),
  targetProjectName: z.string().optional(),
  title: z.string(),
  body: z.string(),
  kind: z.enum(['question', 'change']),
  status: z.enum(['pending', 'approved', 'rejected', 'queued', 'answered', 'blocked']),
  createdAt: z.string(),
  answer: z.string().nullable(),
});
export type ProjectInquiry = z.infer<typeof projectInquirySchema>;
