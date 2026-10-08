import type { FastifyInstance } from 'fastify';
import { isLocalProject, type EventStore, type ProjectRecord } from '@verity/store';
import { z } from 'zod';

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  pull_request: z.unknown().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(z.object({ login: z.string() })),
});

export interface ProjectGitHubIssues {
  connected: boolean;
  viewerLogin: string | null;
  issues: { number: number; title: string; url: string; labels: string[]; assignees: string[] }[];
}

/** A repository-scoped token never leaves the server or follows a pagination URL. */
export async function listProjectGitHubIssues(
  project: ProjectRecord,
  mint: (project: ProjectRecord) => Promise<string | undefined>,
  fetcher: typeof fetch = fetch,
): Promise<ProjectGitHubIssues> {
  if (isLocalProject(project)) return { connected: false, viewerLogin: null, issues: [] };
  const token = await mint(project);
  if (!token) return { connected: false, viewerLogin: null, issues: [] };
  const issues: ProjectGitHubIssues['issues'] = [];
  const path = `/repos/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.repo)}/issues`;
  // The issues endpoint also contains PRs; walk all pages so PR-heavy repositories
  // cannot silently hide their actual issues from the list.
  for (let page = 1; ; page++) {
    const response = await fetcher(
      `https://api.github.com${path}?state=open&per_page=100&page=${String(page)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error('Could not load GitHub issues');
    const entries = z.array(issueSchema).parse(await response.json());
    for (const issue of entries) {
      if (issue.pull_request !== undefined) continue;
      issues.push({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
        assignees: issue.assignees.map((assignee) => assignee.login),
      });
    }
    if (entries.length < 100) break;
  }
  return { connected: true, viewerLogin: null, issues };
}

export function registerProjectGitHubIssueRoutes(
  app: FastifyInstance,
  deps: {
    store: Pick<EventStore, 'getProject' | 'listReadableProjectIds'>;
    list?: ((project: ProjectRecord) => Promise<ProjectGitHubIssues>) | undefined;
  },
): void {
  app.get('/projects/:id/github/issues', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const project = await deps.store.getProject(id);
    if (
      !project ||
      (request.localUserId !== null &&
        !(await deps.store.listReadableProjectIds(request.localUserId)).includes(id))
    ) {
      return reply.code(404).send({ error: 'project not found' });
    }
    if (isLocalProject(project) || !deps.list)
      return { connected: false, viewerLogin: null, issues: [] };
    return deps.list(project);
  });
}
