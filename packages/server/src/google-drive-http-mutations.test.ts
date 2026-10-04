import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProjectGoogleDriveRoutes } from './google-drive-project-routes.js';

afterEach(() => vi.unstubAllGlobals());
async function setup(accessMode: 'read-only' | 'read-write') {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const id = new URL(url).pathname.split('/').at(-1)!;
    if (url.includes('/v2/'))
      return new Response(
        JSON.stringify({
          id,
          title: 'Note',
          mimeType: 'text/plain',
          parents: [{ id: 'root' }],
          etag: '"v2"',
          labels: { trashed: true },
        }),
      );
    return new Response(
      JSON.stringify({
        id,
        name: 'Note',
        mimeType: id === 'root' ? 'application/vnd.google-apps.folder' : 'text/plain',
        parents: id === 'root' ? [] : ['root'],
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const getLinkedFolder = vi.fn(async () => ({
    projectId: 'p',
    folderId: 'root',
    name: 'Root',
    accessMode,
  }));
  const googleAccountIdentity = vi.fn(async () => 'account');
  const app = Fastify();
  registerProjectGoogleDriveRoutes(app, {
    getLinkedFolder,
    googleAccountIdentity,
    googleAccessToken: async () => 'token',
  });
  await app.ready();
  return { app, fetch, getLinkedFolder, googleAccountIdentity };
}
const prefix = '/projects/p/google-drive/folders/root/files';
it('enforces read-only permissions on every existing HTTP mutation route', async () => {
  const { app, fetch } = await setup('read-only');
  try {
    for (const options of [
      {
        method: 'POST' as const,
        url: `${prefix}/create`,
        payload: { name: 'New', kind: 'folder' },
      },
      {
        method: 'POST' as const,
        url: `${prefix}/upload?name=New&mimeType=text/plain`,
        headers: { 'content-type': 'text/plain' },
        payload: 'text',
      },
      {
        method: 'PATCH' as const,
        url: `${prefix}/file`,
        payload: { name: 'Next', expectedVersion: '"v1"', confirmed: true },
      },
      {
        method: 'DELETE' as const,
        url: `${prefix}/file`,
        payload: { expectedVersion: '"v1"', confirmed: true },
      },
      {
        method: 'PUT' as const,
        url: `${prefix}/file/content`,
        payload: { content: 'new', expectedVersion: '"v1"', confirmed: true },
      },
    ])
      expect((await app.inject(options)).statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('requires confirmation and trashes files without a permanent DELETE', async () => {
  const { app, fetch } = await setup('read-write');
  try {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${prefix}/file`,
          payload: { expectedVersion: '"v1"' },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${prefix}/file`,
          payload: { expectedVersion: '"v1"', confirmed: true },
        })
      ).statusCode,
    ).toBe(204);
    const mutation = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(mutation?.[1]?.body as string)).toEqual({ labels: { trashed: true } });
    expect((mutation?.[1]?.headers as Record<string, string>)['If-Match']).toBe('"v1"');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  } finally {
    await app.close();
  }
});
it('protects the linked root even from confirmed deletion', async () => {
  const { app, fetch } = await setup('read-write');
  try {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${prefix}/root`,
          payload: { expectedVersion: '"v1"', confirmed: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  } finally {
    await app.close();
  }
});
it('rejects invalid byte encodings before sending an overwrite', async () => {
  const { app, fetch } = await setup('read-write');
  try {
    const response = await app.inject({
      method: 'PUT',
      url: `${prefix}/file/content`,
      payload: { content: '%%%=', encoding: 'base64', expectedVersion: '"v2"', confirmed: true },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  } finally {
    await app.close();
  }
});

it.each(['permission', 'account'])(
  'rechecks %s immediately before HTTP dispatch',
  async (changed) => {
    const { app, fetch, getLinkedFolder, googleAccountIdentity } = await setup('read-write');
    fetch.mockImplementation(async (url: string) => {
      if (changed === 'permission')
        getLinkedFolder.mockResolvedValue({
          projectId: 'p',
          folderId: 'root',
          name: 'Root',
          accessMode: 'read-only',
        });
      else googleAccountIdentity.mockResolvedValue('other-account');
      return new Response(
        JSON.stringify({
          id: new URL(url).pathname.split('/').at(-1),
          name: 'Note',
          mimeType: 'text/plain',
          parents: new URL(url).pathname.endsWith('/root') ? [] : ['root'],
        }),
      );
    });
    try {
      const response = await app.inject({
        method: 'DELETE',
        url: `${prefix}/file`,
        payload: { expectedVersion: '"v1"', confirmed: true },
      });
      expect(response.statusCode).toBe(403);
      expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    } finally {
      await app.close();
    }
  },
);

it('rejects wildcard overwrite conditions instead of bypassing conflict protection', async () => {
  const { app, fetch } = await setup('read-write');
  try {
    for (const method of ['PATCH', 'DELETE', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: method === 'PUT' ? `${prefix}/file/content` : `${prefix}/file`,
        payload: {
          expectedVersion: '*',
          confirmed: true,
          ...(method === 'PATCH' ? { name: 'Next' } : {}),
          ...(method === 'PUT' ? { content: 'new' } : {}),
        },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  } finally {
    await app.close();
  }
});

it('accepts bounded overwrites above the default HTTP body limit', async () => {
  const { app, fetch } = await setup('read-write');
  const content = 'A'.repeat(3_000_000);
  try {
    const response = await app.inject({
      method: 'PUT',
      url: `${prefix}/file/content`,
      payload: { content, expectedVersion: '"v2"', confirmed: true },
    });
    expect(response.statusCode).toBe(200);
    const body = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body;
    expect(Buffer.isBuffer(body) && body.byteLength).toBe(content.length);
  } finally {
    await app.close();
  }
});
