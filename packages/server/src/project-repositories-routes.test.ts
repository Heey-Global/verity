import type { EventStore, ProjectRecord } from '@verity/store';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { ProjectRepository } from './project-repo-route.js';
import {
  readRepositoryInstructions,
  registerProjectRepositoriesRoutes,
  REPOSITORY_INSTRUCTIONS_MAX_CHARS,
} from './project-repositories-routes.js';

it('validates remote access even when the caller supplies a default branch', async () => {
  const app = Fastify();
  const add = vi.fn();
  const defaultBranch = vi.fn().mockRejectedValue(new Error('access denied'));
  registerProjectRepositoriesRoutes(app, {
    store: {
      getProject: vi.fn().mockResolvedValue({ id: 'p', kind: 'github' }),
      addProjectRepository: add,
    } as unknown as EventStore,
    repositoryFor: vi.fn().mockResolvedValue({ operations: { defaultBranch } }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/projects/p/repositories',
      payload: {
        name: 'Private',
        kind: 'github',
        owner: 'team',
        repo: 'private',
        defaultBranch: 'main',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(defaultBranch).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('reads each repository AGENTS.md on its own and never reports an outage as no file', async () => {
  const app = Fastify();
  const project = { id: 'p', kind: 'github', owner: 'team', repo: 'site' };
  const repository = (id: string, extra: Record<string, unknown>) => ({
    id,
    projectId: 'p',
    name: id,
    kind: 'github',
    owner: 'team',
    repo: id,
    forgeConnectionId: null,
    defaultBranch: null,
    isDefault: false,
    removedAt: null,
    ...extra,
  });
  const files: Record<string, string | null | Error> = {
    site: 'Use the shared UI components.',
    api: null,
    docs: new Error('forge down'),
    big: 'x'.repeat(100_001),
  };
  const reads: [string, string, string][] = [];
  const repositoryFor = vi.fn((target: { repo: string }) => {
    if (target.repo === 'gone') return Promise.resolve(undefined);
    return Promise.resolve({
      operations: {
        defaultBranch: vi.fn().mockResolvedValue('main'),
        readFile: vi.fn((path: string, ref: string) => {
          reads.push([target.repo, path, ref]);
          const file = files[target.repo];
          if (file instanceof Error) return Promise.reject(file);
          return Promise.resolve(
            file === null || file === undefined
              ? null
              : { content: file, revision: `${target.repo}@${ref}` },
          );
        }),
      },
    });
  });
  registerProjectRepositoriesRoutes(app, {
    store: {
      getProject: vi.fn().mockResolvedValue(project),
      listProjectRepositories: vi
        .fn()
        .mockResolvedValue([
          repository('default:p', { name: 'site', repo: 'site', isDefault: true }),
          repository('api', { kind: 'forgejo', forgeConnectionId: 'f', defaultBranch: 'trunk' }),
          repository('docs', {}),
          repository('gone', {}),
          repository('big', {}),
          repository('notes', { kind: 'local' }),
        ]),
    } as unknown as EventStore,
    // Only `operations` is read here; the full ProjectRepository is not needed.
    repositoryFor: repositoryFor as unknown as Parameters<
      typeof registerProjectRepositoriesRoutes
    >[1]['repositoryFor'],
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/projects/p/repository-instructions',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { repositories } = response.json<{ repositories: Record<string, unknown>[] }>();
    expect(repositories.map((entry) => [entry.id, entry.status, entry.branch])).toEqual([
      ['default:p', 'present', 'main'],
      // A configured default branch is read without asking the host for one.
      ['api', 'missing', 'trunk'],
      ['docs', 'unavailable', 'main'],
      ['gone', 'unavailable', null],
      ['big', 'present', 'main'],
    ]);
    expect(repositories[0]).toMatchObject({
      name: 'team/site',
      kind: 'github',
      path: 'AGENTS.md',
      instructions: 'Use the shared UI components.',
      revision: 'site@main',
      truncated: false,
    });
    expect(repositories[1]).toMatchObject({ kind: 'forgejo' });
    expect(repositories[4]).toMatchObject({ truncated: true });
    expect((repositories[4]!.instructions as string).length).toBe(100_000);
    expect(reads).toContainEqual(['api', 'AGENTS.md', 'trunk']);
    // A repository without a code host has no AGENTS.md to read remotely.
    expect(repositoryFor).not.toHaveBeenCalledWith(expect.objectContaining({ repo: 'notes' }));
  } finally {
    await app.close();
  }
});

it('answers 404 for an unknown project without touching a code host', async () => {
  const app = Fastify();
  const repositoryFor = vi.fn();
  registerProjectRepositoriesRoutes(app, {
    store: { getProject: vi.fn().mockResolvedValue(undefined) } as unknown as EventStore,
    repositoryFor,
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/projects/x/repository-instructions',
    });
    expect(response.statusCode).toBe(404);
    expect(repositoryFor).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('marks a hanging code host unavailable without holding back the other repositories', async () => {
  const repository = (id: string, isDefault: boolean) => ({
    id,
    projectId: 'p',
    name: id,
    kind: 'github' as const,
    owner: 'team',
    repo: id,
    forgeConnectionId: null,
    defaultBranch: 'main',
    isDefault,
    removedAt: null,
  });
  const emoji = '😀';
  const content = 'x'.repeat(REPOSITORY_INSTRUCTIONS_MAX_CHARS - 1) + emoji;
  const result = await readRepositoryInstructions(
    {
      listProjectRepositories: vi
        .fn()
        .mockResolvedValue([repository('site', true), repository('slow', false)]),
    },
    { id: 'p', kind: 'github', owner: 'team', repo: 'site' } as ProjectRecord,
    (target) =>
      Promise.resolve({
        operations: {
          readFile: () =>
            target.repo === 'slow'
              ? new Promise<never>(() => undefined)
              : Promise.resolve({ content, revision: 'r' }),
        },
      } as unknown as ProjectRepository),
    50,
  );
  expect(result.map((entry) => [entry.id, entry.status])).toEqual([
    ['site', 'present'],
    ['slow', 'unavailable'],
  ]);
  // The cut falls inside the emoji's surrogate pair; half of it must not remain.
  const shown = (result[0] as { instructions: string }).instructions;
  expect(shown).toBe('x'.repeat(REPOSITORY_INSTRUCTIONS_MAX_CHARS - 1));
  expect(result[0]).toMatchObject({ truncated: true });
});
