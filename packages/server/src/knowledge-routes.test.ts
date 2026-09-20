import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { createKnowledgeInvalidationReconciler } from './knowledge-lifecycle.js';

let ctx: TestDb;
let app: FastifyInstance;
const reconcile = vi.fn(async () => {});
const schedule = vi.fn(async () => {});
const scheduleReconciliation = vi.fn(async () => {});
const wakeMaintenance = vi.fn(async () => {});
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await app?.close();
  await truncateAll(ctx.db);
  reconcile.mockClear();
  schedule.mockClear();
  scheduleReconciliation.mockClear();
  wakeMaintenance.mockClear();
  app = Fastify();
  registerKnowledgeRoutes(app, {
    knowledge: ctx.store.knowledge,
    reconcileInvalidations: reconcile,
    schedule,
    scheduleReconciliation,
    wakeMaintenance,
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
  it('wakes automatic maintenance for ordinary project Source documents', async () => {
    await ctx.store.upsertProject({
      id: 'p',
      owner: 'test',
      repo: 'test',
      containerName: 'test',
      state: 'absent',
      overviewVisible: true,
    });
    const space = (await ctx.store.knowledge.getProjectSpace('p'))!;
    const response = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      payload: {
        folderId: space.sourcesFolderId,
        title: 'Decision',
        bodyMarkdown: 'Use the blue design.',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(schedule).toHaveBeenCalledWith('p', [response.json().document.id]);
    schedule.mockClear();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/knowledge/documents/${response.json().document.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(scheduleReconciliation).toHaveBeenCalledWith('p');
  });
  it('wakes automatic ingestion when a document moves into project Sources', async () => {
    await ctx.store.upsertProject({
      id: 'p',
      owner: 'test',
      repo: 'test',
      containerName: 'test',
      state: 'absent',
      overviewVisible: true,
    });
    const space = (await ctx.store.knowledge.getProjectSpace('p'))!;
    const outside = await ctx.store.knowledge.createFolder({ name: 'Outside' });
    const document = await ctx.store.knowledge.createDocument({
      folderId: outside.id,
      title: 'Moved decision',
      bodyMarkdown: 'Move this into Sources.',
    });
    const preview = (
      await app.inject({
        method: 'POST',
        url: `/knowledge/documents/${document.id}/move-preview`,
        payload: { folderId: space.sourcesFolderId },
      })
    ).json();
    const moved = await app.inject({
      method: 'PATCH',
      url: `/knowledge/documents/${document.id}`,
      payload: { folderId: space.sourcesFolderId, expectedPolicyToken: preview.policyToken },
    });
    expect(moved.statusCode).toBe(200);
    expect(schedule).toHaveBeenCalledWith('p', [document.id]);
    scheduleReconciliation.mockClear();
    const returnPreview = (
      await app.inject({
        method: 'POST',
        url: `/knowledge/documents/${document.id}/move-preview`,
        payload: { folderId: outside.id },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/knowledge/documents/${document.id}`,
          payload: { folderId: outside.id, expectedPolicyToken: returnPreview.policyToken },
        })
      ).statusCode,
    ).toBe(200);
    expect(scheduleReconciliation).toHaveBeenCalledWith('p');
    expect(await ctx.store.knowledge.listWikiMaintenance('p')).toEqual([]);
  });
  it('maintains whole Source subtrees when folders move or are deleted', async () => {
    await ctx.store.upsertProject({
      id: 'p',
      owner: 'test',
      repo: 'test',
      containerName: 'test',
      state: 'absent',
      overviewVisible: true,
    });
    const space = (await ctx.store.knowledge.getProjectSpace('p'))!;
    const outside = await ctx.store.knowledge.createFolder({ name: 'Imported notes' });
    const document = await ctx.store.knowledge.createDocument({
      folderId: outside.id,
      title: 'Nested decision',
      bodyMarkdown: 'Move the whole folder.',
    });
    const enter = (
      await app.inject({
        method: 'POST',
        url: `/knowledge/folders/${outside.id}/move-preview`,
        payload: { parentId: space.sourcesFolderId },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/knowledge/folders/${outside.id}`,
          payload: { parentId: space.sourcesFolderId, expectedPolicyToken: enter.policyToken },
        })
      ).statusCode,
    ).toBe(200);
    expect(wakeMaintenance).toHaveBeenCalledWith('p');
    expect(await ctx.store.knowledge.listWikiMaintenance('p')).toEqual([
      expect.objectContaining({ sourceDocumentId: document.id }),
    ]);

    wakeMaintenance.mockClear();
    expect(
      (await app.inject({ method: 'DELETE', url: `/knowledge/folders/${outside.id}` })).statusCode,
    ).toBe(200);
    expect(wakeMaintenance).toHaveBeenCalledWith('p');
    expect(await ctx.store.knowledge.listWikiMaintenance('p')).toEqual([]);
    expect(await ctx.store.knowledge.listWikiReconciliations()).toEqual([
      expect.objectContaining({ projectId: 'p' }),
    ]);
  });
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
    expect(reconcile).toHaveBeenCalledOnce();
    expect(await ctx.store.knowledge.isSessionInvalidated('s')).toBe(true);
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

it('keeps invalidation pending after a failed backend stop and retries without deleting history', async () => {
  const folder = await ctx.store.knowledge.createFolder({ name: 'Notes' });
  await ctx.store.knowledge.setGrants('p', [{ folderId: folder.id, mode: 'read' }]);
  await ctx.store.appendEvent('s', { t: 'text', delta: 'Retained history' });
  await ctx.store.knowledge.setGrants('p', []);
  const stop = vi.fn(async () => {});
  stop.mockRejectedValueOnce(new Error('termination unconfirmed'));
  const closeSession = vi.fn();
  const cleanup = createKnowledgeInvalidationReconciler({
    store: ctx.store,
    conductor: {
      runBackendHandoff: async (_id, fn) => {
        await stop();
        return fn();
      },
      clearQueue: async () => [],
      closeSession,
    },
  });
  await expect(cleanup()).rejects.toThrow('termination unconfirmed');
  expect(await ctx.store.knowledge.listPendingInvalidatedSessions()).toEqual(['s']);
  await cleanup();
  expect(await ctx.store.knowledge.listPendingInvalidatedSessions()).toEqual([]);
  expect(await ctx.store.knowledge.isSessionInvalidated('s')).toBe(true);
  expect(await ctx.store.getEvents('s')).toEqual([
    expect.objectContaining({ t: 'text', delta: 'Retained history' }),
  ]);
  expect(closeSession).toHaveBeenCalledWith('s');
});
