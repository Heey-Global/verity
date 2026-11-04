import { withProjectTransportAuthority } from './project-transport-authority.js';
import { describe, expect, it } from 'vitest';

import type { GoogleFetch, GoogleHttpResponse } from './google-drive.js';
import { getDocsDocument, getDocsDocumentMetadata, updateDocsDocument } from './google-docs.js';

function response(body: unknown, status = 200): GoogleHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

describe('Google Docs client', () => {
  it('reads bounded document content and metadata', async () => {
    let url = '';
    const fetch: GoogleFetch = (requestedUrl) => {
      url = requestedUrl;
      return Promise.resolve(
        response({
          documentId: 'doc-1',
          title: 'Plan',
          revisionId: 'rev-1',
          tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [] } } }],
        }),
      );
    };
    await expect(getDocsDocument('token', 'doc/1', { fetch })).resolves.toEqual({
      documentId: 'doc-1',
      title: 'Plan',
      revisionId: 'rev-1',
      tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [] } } }],
    });
    expect(url).toContain(
      '/documents/doc%2F1?includeTabsContent=true&fields=documentId,title,revisionId,tabs',
    );
  });

  it('inspects metadata without requesting tab content', async () => {
    let url = '';
    const fetch: GoogleFetch = (requestedUrl) => {
      url = requestedUrl;
      return Promise.resolve(
        response({
          documentId: 'doc-1',
          title: 'Plan',
          revisionId: 'rev-1',
          tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Main' } }],
        }),
      );
    };

    await expect(getDocsDocumentMetadata('token', 'doc-1', { fetch })).resolves.toMatchObject({
      documentId: 'doc-1',
      revisionId: 'rev-1',
    });
    expect(url).toContain('includeTabsContent=true');
    expect(url).toContain('tabs(tabProperties,childTabs(tabProperties))');
    expect(url).not.toContain('documentTab');
  });

  it('refuses document content above the tool output limit', async () => {
    const fetch: GoogleFetch = () =>
      Promise.resolve(
        response({
          documentId: 'doc-1',
          title: 'Large',
          revisionId: 'rev-1',
          tabs: [{ documentTab: { body: { content: 'x'.repeat(1_000_000) } } }],
        }),
      );

    await expect(getDocsDocument('token', 'doc-1', { fetch })).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('sends an optional revision guard and requires the returned revision', async () => {
    let body = '';
    const fetch: GoogleFetch = (_url, init) => {
      body = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(
        response({ replies: [{ insertText: {} }], writeControl: { requiredRevisionId: 'rev-2' } }),
      );
    };
    await expect(
      updateDocsDocument('token', 'doc-1', [{ insertText: { text: 'Hello' } }], 'rev-1', {
        fetch,
      }),
    ).resolves.toEqual({
      replies: [{ insertText: {} }],
      writeControl: { requiredRevisionId: 'rev-2' },
    });
    expect(JSON.parse(body)).toEqual({
      requests: [{ insertText: { text: 'Hello' } }],
      writeControl: { requiredRevisionId: 'rev-1' },
    });
  });

  it('redacts upstream error details', async () => {
    const fetch: GoogleFetch = () =>
      Promise.resolve(
        response({ error: { status: 'PERMISSION_DENIED', message: 'private' } }, 403),
      );
    await expect(getDocsDocument('token', 'doc-1', { fetch })).rejects.toMatchObject({
      name: 'GoogleDocsError',
      reason: 'http_403_PERMISSIONDENIED',
    });
  });
});

it('keeps the actual Google Docs fetch inside the trusted project generation', async () => {
  const generation = new AbortController();
  let providerSignal: AbortSignal | undefined;
  await expect(
    withProjectTransportAuthority(
      {
        projectId: 'p',
        containerGeneration: 'old',
        signal: generation.signal,
        authorize: async () => {},
      },
      () =>
        getDocsDocument('token', 'doc', {
          fetch: async (_url, init) => {
            providerSignal = init?.signal;
            generation.abort();
            expect(providerSignal?.aborted).toBe(true);
            return response({ documentId: 'doc', title: 'Plan', revisionId: 'rev', tabs: [] });
          },
        }),
    ),
  ).rejects.toThrow();
  expect(providerSignal?.aborted).toBe(true);
});
