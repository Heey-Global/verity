import { describe, expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';
import type { KnowledgeFilesScope } from './knowledge-files-api.js';

const respond = (body: unknown) =>
  vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));

const client = (transport: typeof fetch, upload?: typeof fetch) =>
  new VerityClient({
    baseUrl: 'https://example.test',
    fetch: transport,
    ...(upload ? { uploadFetch: upload } : {}),
  });

/** What one call sent: method, URL relative to the server, and parsed JSON body. */
const sent = (transport: ReturnType<typeof respond>, index = 0) => {
  const [url, init] = transport.mock.calls[index]!;
  return {
    method: init?.method ?? 'GET',
    url: (url as string).replace('https://example.test', ''),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    headers: init?.headers as Record<string, string> | undefined,
  };
};

const scopes: Array<[KnowledgeFilesScope, string]> = [
  [{ kind: 'shared' }, '/knowledge/shared'],
  [{ kind: 'project', projectId: 'p/1' }, '/projects/p%2F1/knowledge'],
];

describe.each(scopes)('knowledge file calls for %o', (scope, base) => {
  const relocated = {
    path: 'insights/archive/Plan Ä.md',
    linksUpdated: [{ path: 'insights/index.md', links: 2 }],
  };

  it('renames and moves with the paths in the body and parses the link report', async () => {
    const transport = respond(relocated);
    const verity = client(transport);
    await expect(
      verity.renameKnowledgeFile(scope, 'insights/Plan.md', 'Plan Ä.md'),
    ).resolves.toEqual(relocated);
    expect(sent(transport)).toMatchObject({
      method: 'POST',
      url: `${base}/files/rename`,
      body: { path: 'insights/Plan.md', name: 'Plan Ä.md' },
    });
    await verity.moveKnowledgeFile(scope, 'insights/Plan Ä.md', 'insights/archive');
    expect(sent(transport, 1)).toMatchObject({
      method: 'POST',
      url: `${base}/files/move`,
      body: { path: 'insights/Plan Ä.md', toPath: 'insights/archive' },
    });
  });

  it('refuses a rename response without the link report', async () => {
    const verity = client(respond({ path: 'insights/x.md' }));
    await expect(verity.renameKnowledgeFile(scope, 'insights/y.md', 'x.md')).rejects.toThrow();
  });

  it('encodes paths in the query of delete, backlinks and upload', async () => {
    const transport = respond({ pages: [{ path: 'insights/index.md', links: 1 }] });
    const verity = client(transport);
    await verity.deleteKnowledgeFile(scope, 'sources/a&b #1.pdf');
    expect(sent(transport)).toMatchObject({
      method: 'DELETE',
      url: `${base}/files?path=sources%2Fa%26b%20%231.pdf`,
    });
    await expect(verity.listKnowledgeBacklinks(scope, 'insights/Ä.md')).resolves.toEqual({
      pages: [{ path: 'insights/index.md', links: 1 }],
    });
    expect(sent(transport, 1).url).toBe(`${base}/files/backlinks?path=insights%2F%C3%84.md`);

    const upload = respond({ path: 'sources/Prüfung.pdf', size: 3 });
    const data = new Blob(['pdf'], { type: 'application/pdf' });
    await client(transport, upload).uploadKnowledgeFile(scope, {
      path: 'sources',
      fileName: 'Prüfung.pdf',
      data,
    });
    const request = sent(upload);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${base}/files?path=sources&fileName=Pr%C3%BCfung.pdf`);
    expect(request.headers?.['content-type']).toBe('application/octet-stream');
    // The body reports the binary type even though the picked file is a PDF.
    expect((request.body as Blob).type).toBe('application/octet-stream');
  });

  it('creates a folder inside the given parent', async () => {
    const transport = respond({ path: 'insights/Topic' });
    await expect(
      client(transport).createKnowledgeFileFolder(scope, 'insights', 'Topic'),
    ).resolves.toEqual({ path: 'insights/Topic' });
    expect(sent(transport)).toMatchObject({
      method: 'POST',
      url: `${base}/folders`,
      body: { path: 'insights', name: 'Topic' },
    });
  });
});

describe('folder calls outside knowledge', () => {
  it('creates a folder in a session root', async () => {
    const transport = respond({ path: 'src/new' });
    await expect(
      client(transport).createSessionFolder('s 1', 'worktree', 'src', 'new'),
    ).resolves.toEqual({ path: 'src/new' });
    expect(sent(transport)).toMatchObject({
      method: 'POST',
      url: '/sessions/s%201/files/folders',
      body: { root: 'worktree', path: 'src', name: 'new' },
    });
  });

  it('creates, renames and moves in a linked Google Drive folder', async () => {
    const file = { id: 'f/1', name: 'Plans', mimeType: 'application/vnd.google-apps.folder' };
    const transport = respond({ file });
    const verity = client(transport);
    await expect(
      verity.createProjectGoogleDriveFolder('p', 'link', { parentId: 'parent', name: 'Plans' }),
    ).resolves.toEqual(file);
    expect(sent(transport)).toMatchObject({
      method: 'POST',
      url: '/projects/p/google-drive/folders/link/files/create',
      body: { parentId: 'parent', name: 'Plans', kind: 'folder' },
    });
    await verity.updateProjectGoogleDriveFile('p', 'link', 'f/1', {
      expectedVersion: '7',
      name: 'Plans 2026',
      parentId: 'other',
    });
    expect(sent(transport, 1)).toMatchObject({
      method: 'PATCH',
      url: '/projects/p/google-drive/folders/link/files/f%2F1',
      // The server takes a change only as confirmed.
      body: { expectedVersion: '7', name: 'Plans 2026', parentId: 'other', confirmed: true },
    });
  });
});
