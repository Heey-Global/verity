import { beforeEach, describe, expect, it } from 'vitest';
import { app, ctx } from './server-fixture.test-helper.js';

describe('PATCH /projects/:id/profile', () => {
  beforeEach(async () => {
    await ctx.store.upsertProject({
      id: 'p-profile',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
  });

  it('renames the project and leaves its repository identity alone', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/p-profile/profile',
      payload: { name: '  Verity Plattform  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Verity Plattform' });
    expect(await ctx.store.getProject('p-profile')).toMatchObject({
      name: 'Verity Plattform',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
    });
    // The list is memoised; the new name must reach it straight away.
    const list = await app.inject({ method: 'GET', url: '/projects' });
    expect(
      list.json<{ id: string; name: string }[]>().find((p) => p.id === 'p-profile')?.name,
    ).toBe('Verity Plattform');
  });

  it('sets and clears the description beside the name', async () => {
    const set = await app.inject({
      method: 'PATCH',
      url: '/projects/p-profile/profile',
      payload: { name: 'Verity', description: ' Agent workspace ' },
    });
    expect(set.json()).toEqual({ name: 'Verity', description: 'Agent workspace' });
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/projects/p-profile/profile',
      payload: { description: '' },
    });
    expect(cleared.json()).toEqual({ description: null });
    expect((await ctx.store.getProject('p-profile'))?.name).toBe('Verity');
  });

  it('refuses an empty name, an overlong one and an empty request', async () => {
    for (const payload of [{ name: '   ' }, { name: 'x'.repeat(101) }, {}]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/projects/p-profile/profile',
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect((await ctx.store.getProject('p-profile'))?.name).toBe('verity');
  });

  it('uses the same supplementary Unicode length limit for creation and rename', async () => {
    for (const [units, status] of [
      [50, 201],
      [51, 400],
    ] as const) {
      const name = '😀'.repeat(units);
      const created = await app.inject({
        method: 'POST',
        url: '/projects',
        payload: { kind: 'local', name },
      });
      expect(created.statusCode).toBe(status);
      const renamed = await app.inject({
        method: 'PATCH',
        url: '/projects/p-profile/profile',
        payload: { name },
      });
      expect(renamed.statusCode).toBe(status === 201 ? 200 : 400);
    }
  });

  it('tells the app in the detail whether this person may edit them', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/p-profile' });
    // Without the auth gate there is one implicit administrator.
    expect(res.json()).toMatchObject({
      project: { name: 'verity' },
      viewer: { canExecute: true, canCode: true, canManage: true },
    });
  });

  it('404s an unknown project', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/projects/missing/profile',
      payload: { name: 'Anything' },
    });
    expect(res.statusCode).toBe(404);
  });
});
