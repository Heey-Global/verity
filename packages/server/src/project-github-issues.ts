import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  isLocalProject,
  projectForRepository,
  type EventStore,
  type ProjectRecord,
} from '@verity/store';
import { z } from 'zod';
import type { ForgeIssueList } from './forge-provider.js';
import type { HttpFetch } from './github.js';

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  pull_request: z.unknown().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(z.object({ login: z.string() })),
});

/** The GitHub-backed {@link ForgeIssueList}; the route keeps its GitHub path for clients. */
export type ProjectGitHubIssues = ForgeIssueList;

/** A repository-scoped token never leaves the server or follows a pagination URL. */
export async function listProjectGitHubIssues(
  project: ProjectRecord,
  mint: (project: ProjectRecord) => Promise<string | undefined>,
  fetcher: HttpFetch = (url, init) => fetch(url, init),
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

/** Open issues of one repository connected to a project. `unavailable` means its
 *  code host could not be asked (down, slow, no credentials) — never "no issues". */
export type RepositoryIssues = {
  id: string;
  name: string;
  kind: 'github' | 'forgejo';
  owner: string;
  repo: string;
  isDefault: boolean;
} & (
  | { status: 'ok'; viewerLogin: string | null; issues: ForgeIssueList['issues'] }
  | { status: 'unavailable' }
);

/** Bounds one repository's whole listing, pages included, so a slow host cannot
 *  hold the list for every other repository. */
const REPOSITORY_ISSUES_TIMEOUT_MS = 20_000;

/**
 * Open issues of every GitHub or Forgejo repository connected to the project,
 * the default repository first. Each repository is asked on its own, so one
 * failing host marks only its own entry unavailable.
 */
export async function listProjectIssues(
  store: Pick<EventStore, 'listProjectRepositories'>,
  project: ProjectRecord,
  list: ((repository: ProjectRecord) => Promise<ForgeIssueList>) | undefined,
  timeoutMs = REPOSITORY_ISSUES_TIMEOUT_MS,
): Promise<RepositoryIssues[]> {
  const repositories = (await store.listProjectRepositories(project.id))
    .filter((repository) => repository.kind === 'github' || repository.kind === 'forgejo')
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return Promise.all(
    repositories.map(async (repository): Promise<RepositoryIssues> => {
      const identity = {
        id: repository.id,
        name: repository.isDefault ? `${repository.owner}/${repository.repo}` : repository.name,
        kind: repository.kind as 'github' | 'forgejo',
        owner: repository.owner,
        repo: repository.repo,
        isDefault: repository.isDefault,
      };
      const unavailable = { ...identity, status: 'unavailable' as const };
      if (!list) return unavailable;
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          list(projectForRepository(project, repository)),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeoutMs);
          }),
        ]);
        if (!result?.connected) return unavailable;
        return {
          ...identity,
          status: 'ok',
          viewerLogin: result.viewerLogin,
          issues: result.issues,
        };
      } catch {
        return unavailable;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

export function registerProjectGitHubIssueRoutes(
  app: FastifyInstance,
  deps: {
    store: Pick<EventStore, 'getProject' | 'listReadableProjectIds' | 'listProjectRepositories'>;
    /** Lists one repository; called with the project bound to that repository. */
    list?: ((project: ProjectRecord) => Promise<ProjectGitHubIssues>) | undefined;
  },
): void {
  const readable = async (request: FastifyRequest): Promise<ProjectRecord | undefined> => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const project = await deps.store.getProject(id);
    if (
      !project ||
      (request.localUserId !== null &&
        !(await deps.store.listReadableProjectIds(request.localUserId)).includes(id))
    )
      return undefined;
    return project;
  };
  // The default repository only; kept for app versions that predate `/issues`.
  app.get('/projects/:id/github/issues', async (request, reply) => {
    const project = await readable(request);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (isLocalProject(project) || !deps.list)
      return { connected: false, viewerLogin: null, issues: [] };
    return deps.list(project);
  });
  app.get('/projects/:id/issues', async (request, reply) => {
    const project = await readable(request);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    reply.header('cache-control', 'no-store');
    return { repositories: await listProjectIssues(deps.store, project, deps.list) };
  });
}
