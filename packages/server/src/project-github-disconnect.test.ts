import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { ProvisioningError } from './provisioner.js';
import { bus, conductor, ctx } from './server-fixture.test-helper.js';

describe('POST /projects/:id/disconnect-github', () => {
  async function setup() {
    await ctx.store.upsertProject({
      id: 'disconnect',
      owner: 'deleted-org',
      repo: 'deleted-repo',
      kind: 'github',
      containerName: 'disconnect-test',
      state: 'active',
    });
  }
  it('returns the retained project in local mode without needing GitHub access', async () => {
    await setup();
    const disconnectGitHub = vi.fn(
      async () => (await ctx.store.disconnectProjectFromGitHub('disconnect'))!,
    );
    const app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: {
        provision: vi.fn(),
        disconnectGitHub,
        withProjectExclusiveMutation: async (_id, mutate) => mutate(),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/projects/disconnect/disconnect-github',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        project: { id: 'disconnect', kind: 'local', cloneDir: 'deleted-org-deleted-repo' },
      });
      expect(disconnectGitHub).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
  it('rejects busy projects before disconnecting and retains the GitHub identity', async () => {
    await setup();
    const disconnectGitHub = vi.fn();
    const app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: {
        provision: vi.fn(),
        disconnectGitHub,
        withProjectExclusiveMutation: async () => {
          throw new ProvisioningError('Finish project activity before disconnecting');
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/projects/disconnect/disconnect-github',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Finish project activity');
      expect(disconnectGitHub).not.toHaveBeenCalled();
      expect((await ctx.store.getProject('disconnect'))?.kind).toBe('github');
    } finally {
      await app.close();
    }
  });
  it('requires configured lifecycle coordination', async () => {
    await setup();
    const app = buildServer({ eventStore: ctx.store, bus, conductor });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/projects/disconnect/disconnect-github' }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
  it('returns not found for a missing project', async () => {
    const app = buildServer({ eventStore: ctx.store, bus, conductor });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/projects/missing/disconnect-github' }))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});

it('surfaces the actionable GitHub ruleset rejection from a linking failure', async () => {
  await ctx.store.upsertProject({
    id: 'link-rejected',
    owner: '__local__',
    repo: 'code',
    kind: 'local',
    containerName: 'link-rejected',
    state: 'absent',
  });
  const app = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    ghTokenMint: async () => 'token',
    provisioner: {
      provision: vi.fn(),
      linkCloneToGitHub: async () => {
        throw new ProvisioningError(
          'Push rejected',
          new Error('GH013: Commits must have verified signatures'),
        );
      },
      withProjectExclusiveMutation: async (_id, mutate) => mutate(),
    },
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/link-rejected/link-github',
      payload: { repo: 'acme/code' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Commits must have verified signatures');
    expect(res.json().error).toContain('verified Git email');
    expect((await ctx.store.getProject('link-rejected'))?.kind).toBe('local');
  } finally {
    await app.close();
  }
});

it('persists the published default branch before recreating a linked Sandbox', async () => {
  await ctx.store.upsertProject({
    id: 'link-master',
    owner: '__local__',
    repo: 'code',
    kind: 'local',
    containerName: 'link-master',
    state: 'active',
  });
  const recreateContainer = vi.fn(async () => {
    expect((await ctx.store.getProjectSettingsRaw('link-master'))?.defaultBranch).toBe('master');
    return (await ctx.store.getProject('link-master'))!;
  });
  const app = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    ghTokenMint: async () => 'token',
    provisioner: {
      provision: vi.fn(),
      linkCloneToGitHub: async () => ({
        defaultBranch: 'master',
        importBranch: 'verity/import-main',
      }),
      recreateContainer,
      withProjectExclusiveMutation: async (_id, mutate) => mutate(),
    },
  });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/link-master/link-github',
      payload: { repo: 'acme/code' },
    });
    expect(res.statusCode).toBe(200);
    expect(recreateContainer).toHaveBeenCalledOnce();
    expect((await ctx.store.getProjectSettingsRaw('link-master'))?.defaultBranch).toBe('master');
  } finally {
    await app.close();
  }
});
