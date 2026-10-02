import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { registerKnowledgeRoutes } from './knowledge-routes.js';

let ctx: TestDb;
let app: FastifyInstance;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await app?.close();
  await truncateAll(ctx.db);
  app = Fastify();
  registerKnowledgeRoutes(app, {
    knowledge: ctx.store.knowledge,
  });
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'test',
    repo: 'test',
    containerName: 'test',
    state: 'absent',
  });
  await ctx.store.createSession({
    sessionId: 's',
    projectId: 'p',
    worktree: '/test',
    model: 'test',
  });
});
afterAll(async () => {
  await app?.close();
});

describe('knowledge management routes', () => {
  it('supports editor revisions and reports a conflicting save without losing the saved body', async () => {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Notes' });
    const create = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      payload: { folderId: folder.id, title: 'Guide', bodyMarkdown: '# Original' },
    });
    expect(create.statusCode).toBe(200);
    const document = create.json().document;
    const edit = {
      title: 'Guide',
      bodyMarkdown: '# Edited',
      expectedRevisionId: document.currentRevisionId,
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/knowledge/documents/${document.id}`,
          payload: edit,
        })
      ).statusCode,
    ).toBe(200);
    const stale = await app.inject({
      method: 'PUT',
      url: `/knowledge/documents/${document.id}`,
      payload: { ...edit, bodyMarkdown: 'Overwrite' },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'GET', url: `/knowledge/documents/${document.id}` })).json()
        .document.bodyMarkdown,
    ).toBe('# Edited');
    expect(
      (
        await app.inject({ method: 'GET', url: `/knowledge/documents/${document.id}/revisions` })
      ).json().revisions,
    ).toHaveLength(2);
  });
  it('requires a current reviewed policy token for moves and reconciles revoked contexts', async () => {
    const root = await ctx.store.knowledge.createFolder({ name: 'Shared' });
    const child = await ctx.store.knowledge.createFolder({ parentId: root.id, name: 'Child' });
    await ctx.store.knowledge.setGrants('p', [{ folderId: root.id, mode: 'read' }]);
    const url = `/knowledge/folders/${child.id}`;
    expect(
      (await app.inject({ method: 'PATCH', url, payload: { parentId: null } })).statusCode,
    ).toBe(400);
    const preview = (
      await app.inject({ method: 'POST', url: `${url}/move-preview`, payload: { parentId: null } })
    ).json();
    expect(preview.affectedProjects).toEqual([
      expect.objectContaining({ projectId: 'p', lostRead: 1 }),
    ]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url,
          payload: { parentId: null, expectedPolicyToken: preview.policyToken },
        })
      ).statusCode,
    ).toBe(200);
    expect(await ctx.store.getSession('s')).toBeDefined();
  });
  it('preserves relative Markdown paths through import/export and rejects traversal', async () => {
    const folder = await ctx.store.knowledge.createFolder({ name: 'Library' });
    const documents = [{ path: 'Guides/intro.md', bodyMarkdown: '# Welcome' }];
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/knowledge/import',
          payload: { folderId: folder.id, documents },
        })
      ).json(),
    ).toEqual({ imported: 1 });
    expect(
      (await app.inject({ method: 'GET', url: `/knowledge/export?folderId=${folder.id}` })).json(),
    ).toEqual({ documents });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/knowledge/import',
          payload: {
            folderId: folder.id,
            documents: [{ path: '../escape.md', bodyMarkdown: 'x' }],
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});

it('deleting a source preserves the session and reports missing content on a subsequent read', async () => {
  const folder = await ctx.store.knowledge.createFolder({ name: 'Notes' });
  const document = await ctx.store.knowledge.createDocument({
    folderId: folder.id,
    title: 'Removed',
    bodyMarkdown: 'Content',
  });
  await ctx.store.appendEvent('s', { t: 'text', delta: 'Retained history' });
  expect(
    (await app.inject({ method: 'DELETE', url: `/knowledge/documents/${document.id}` })).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: 'GET', url: `/knowledge/documents/${document.id}` })).statusCode,
  ).toBe(404);
  expect(await ctx.store.getSession('s')).toBeDefined();
  expect(await ctx.store.getEvents('s')).toEqual([
    expect.objectContaining({ t: 'text', delta: 'Retained history' }),
  ]);
});
