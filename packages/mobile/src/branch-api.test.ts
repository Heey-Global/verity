import { expect, it } from 'vitest';
import { branchListSchema } from './branch-api.js';

it('keeps same-number PRs from separate repositories and accepts legacy branch responses', () => {
  const pull = {
    number: 7,
    title: 'Update API',
    url: 'https://github.com/team/api/pull/7',
    phase: 'open',
    pipeline: 'running',
    mergeable: null,
    checks: { completed: 1, total: 3, failed: 0, successful: 1, pending: 2 },
  };
  const legacy = { current: 'feat/api', switchable: [], pullRequest: pull };
  const repository = { name: 'api', owner: 'team', repo: 'api', id: 'default:p', isDefault: true };
  const rows = [
    { ...pull, repository },
    {
      ...pull,
      url: 'https://forge.test/team/app/pulls/7',
      repository: {
        ...repository,
        id: 'app',
        name: 'app',
        repo: 'app',
        isDefault: false,
        codeHost: { provider: 'forgejo', baseUrl: 'https://forge.test' },
      },
    },
  ];
  expect(branchListSchema.parse(legacy).pullRequests).toBeUndefined();
  expect(branchListSchema.parse({ ...legacy, pullRequests: rows }).pullRequests).toEqual(rows);
});
