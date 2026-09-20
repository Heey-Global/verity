import { describe, expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';

describe('knowledge client', () => {
  it('carries the loaded revision to the server and encodes document identifiers', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          document: {
            id: 'a/b',
            folderId: 'folder',
            title: 'Rules',
            bodyMarkdown: 'new',
            currentRevisionId: 'v2',
          },
        }),
        { status: 200 },
      ),
    );
    const client = new VerityClient({ baseUrl: 'https://example.test', fetch: transport });
    await client.saveKnowledgeDocument('a/b', {
      title: 'Rules',
      bodyMarkdown: 'new',
      expectedRevisionId: 'v1',
    });
    expect(transport.mock.calls[0]?.[0]).toContain('/knowledge/documents/a%2Fb');
    expect(JSON.parse(transport.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      expectedRevisionId: 'v1',
    });
  });
  it('rejects unknown grant modes instead of accepting authority from a malformed response', async () => {
    const client = new VerityClient({
      baseUrl: 'https://example.test',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ grants: [{ folderId: 'f', mode: 'owner' }] }), {
          status: 200,
        }),
      ),
    });
    await expect(client.listKnowledgeGrants('p')).rejects.toThrow();
  });
});

it('sends the reviewed policy token with a move and preserves pagination parameters', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          document: { id: 'doc', folderId: 'new', title: 'Rules', currentRevisionId: 'v1' },
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] })));
  const client = new VerityClient({ baseUrl: 'https://example.test', fetch: transport });
  await client.moveKnowledgeDocument('doc', 'new', 'reviewed-policy');
  expect(JSON.parse(transport.mock.calls[0]?.[1]?.body as string)).toEqual({
    folderId: 'new',
    expectedPolicyToken: 'reviewed-policy',
  });
  await client.listKnowledgeDocuments('new', 'rules', 100, 100);
  expect(transport.mock.calls[1]?.[0]).toContain('offset=100&limit=100');
});

it('preserves the closed-session code so the app can distinguish knowledge revocation', async () => {
  const client = new VerityClient({
    baseUrl: 'https://example.test',
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'knowledgeSessionClosed', error: 'Knowledge access changed' }),
          { status: 409 },
        ),
      ),
  });
  await expect(client.listKnowledgeGrants('p')).rejects.toMatchObject({
    status: 409,
    code: 'knowledgeSessionClosed',
  });
});

it('loads the requested history page and preserves the originating session', async () => {
  const revisions = [
    {
      id: 'old',
      documentId: 'doc',
      bodyMarkdown: 'historical',
      authorIdentity: 'agent',
      projectId: 'p',
      sessionId: 's',
      turnId: 't',
      createdAt: '2026-09-19T00:00:00Z',
    },
  ];
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ revisions })));
  const client = new VerityClient({ baseUrl: 'https://example.test', fetch: transport });
  expect(await client.listKnowledgeRevisions('doc', 100, 50)).toEqual(revisions);
  expect(transport.mock.calls[0]?.[0]).toContain('/revisions?offset=100&limit=50');
});

it('keeps fixed grant metadata and sends explicit overview revision approval', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ grants: [{ folderId: 'sources', mode: 'read', fixed: 'project' }] }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          overview: {
            documentId: 'doc',
            revisionId: 'v2',
            title: 'Overview',
            bodyMarkdown: 'Approved',
          },
        }),
      ),
    );
  const client = new VerityClient({ baseUrl: 'https://example.test', fetch: transport });
  expect(await client.listKnowledgeGrants('project')).toEqual([
    { folderId: 'sources', mode: 'read', fixed: 'project' },
  ]);
  await client.approveProjectKnowledgeOverview('project', 'doc', 'v2');
  expect(JSON.parse(transport.mock.calls[1]?.[1]?.body as string)).toEqual({
    documentId: 'doc',
    expectedRevisionId: 'v2',
  });
});

it('downloads exact original bytes and URL-encodes source revisions', async () => {
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
  const client = new VerityClient({ baseUrl: 'https://example.test', fetch: transport });
  expect(new Uint8Array(await client.downloadKnowledgeOriginal('doc/id', 'revision/id'))).toEqual(
    bytes,
  );
  expect(transport.mock.calls[0]?.[0]).toContain(
    '/knowledge/documents/doc%2Fid/original?revisionId=revision%2Fid',
  );
});

it('round-trips original metadata and bytes through the portable source bundle', async () => {
  const bundle = {
    version: 1,
    documents: [
      {
        path: 'Sources/Logo.png.md',
        bodyMarkdown: 'Logo original',
        original: {
          filename: 'Logo.png',
          mediaType: 'image/png',
          base64: 'iVBORw==',
          sha256: 'digest',
          processingState: 'ready',
          processingNote: 'Raster preview available',
          locators: [],
          previews: [{ label: 'Original', mediaType: 'image/png', base64: 'iVBORw==' }],
        },
      },
    ],
  };
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(bundle)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ imported: 1 })));
  const client = new VerityClient({ baseUrl: 'https://example.test', fetch: transport });
  const exported = await client.exportKnowledgeSourceBundle('source/folder');
  await client.importKnowledgeSourceBundle('destination', exported);
  expect(JSON.parse(transport.mock.calls[1]?.[1]?.body as string)).toEqual({
    folderId: 'destination',
    ...bundle,
  });
  expect(transport.mock.calls[0]?.[0]).toContain('folderId=source%2Ffolder');
});
