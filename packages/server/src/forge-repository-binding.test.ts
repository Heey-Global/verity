import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { resolveForgeRepositoryBinding } from './forge-repository-binding.js';

const binding = {
  projectId: 'p',
  owner: 'app',
  repo: 'main',
  forgeConnectionId: 'legacy-github',
  containerGeneration: 'g',
};
function store(removed = false) {
  return {
    listProjectRepositories: vi.fn(async () => [
      {
        id: 'default:p',
        kind: 'github',
        owner: 'app',
        repo: 'main',
        isDefault: true,
        removedAt: null,
        forgeConnectionId: 'legacy-github',
      },
      {
        id: 'extra',
        kind: 'github',
        owner: 'other-org',
        repo: 'api',
        isDefault: false,
        removedAt: removed ? new Date() : null,
        forgeConnectionId: 'legacy-github',
      },
    ]),
    forgeConnections: { get: vi.fn() },
  } as unknown as EventStore;
}
describe('repository binding selection', () => {
  it('selects a separately assigned repository in another organization', async () => {
    expect(
      await resolveForgeRepositoryBinding(
        store(),
        binding,
        'github.com',
        '/other-org/api.git/info/refs?service=git-upload-pack',
      ),
    ).toMatchObject({ owner: 'other-org', repo: 'api', projectId: 'p', containerGeneration: 'g' });
  });
  it('refuses unassigned, removed and lookalike remotes', async () => {
    expect(
      await resolveForgeRepositoryBinding(
        store(),
        binding,
        'github.com',
        '/other-org/api-evil.git/info/refs',
      ),
    ).toBeUndefined();
    expect(
      await resolveForgeRepositoryBinding(
        store(true),
        binding,
        'github.com',
        '/other-org/api.git/git-receive-pack',
      ),
    ).toBeUndefined();
    expect(
      await resolveForgeRepositoryBinding(
        store(),
        binding,
        'evil.example',
        '/other-org/api.git/info/refs',
      ),
    ).toBeUndefined();
  });
  it('allows release asset uploads only for assigned repositories', async () => {
    expect(
      await resolveForgeRepositoryBinding(
        store(),
        binding,
        'uploads.github.com',
        '/repos/other-org/api/releases/7/assets?name=file',
      ),
    ).toMatchObject({ owner: 'other-org', repo: 'api' });
    expect(
      await resolveForgeRepositoryBinding(
        store(true),
        binding,
        'uploads.github.com',
        '/repos/other-org/api/releases/7/assets',
      ),
    ).toBeUndefined();
  });
  it('resolves REST operations only under the selected repository boundary', async () => {
    expect(
      await resolveForgeRepositoryBinding(
        store(),
        binding,
        'api.github.com',
        '/repos/other-org/api/pulls',
      ),
    ).toMatchObject({ owner: 'other-org', repo: 'api' });
    expect(
      await resolveForgeRepositoryBinding(
        store(),
        binding,
        'api.github.com',
        '/repos/other-org/api-evil/pulls',
      ),
    ).toBeUndefined();
  });
});

it('offers only current GitHub assignments for full GraphQL policy validation', async () => {
  expect(
    await resolveForgeRepositoryBinding(store(), binding, 'api.github.com', '/graphql'),
  ).toEqual([
    expect.objectContaining({ owner: 'app', repo: 'main' }),
    expect.objectContaining({ owner: 'other-org', repo: 'api' }),
  ]);
  expect(
    await resolveForgeRepositoryBinding(store(true), binding, 'api.github.com', '/graphql'),
  ).toHaveLength(1);
});
