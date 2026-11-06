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
