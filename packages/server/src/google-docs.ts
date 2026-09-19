import type { GoogleFetch, GoogleTransportOptions } from './google-drive.js';

const GOOGLE_DOCS_API = 'https://docs.googleapis.com/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_DOCUMENT_BYTES = 1_000_000;

export class GoogleDocsError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GoogleDocsError';
  }
}

export interface DocsDocument {
  documentId: string;
  title: string;
  revisionId: string;
  tabs?: unknown;
}

export interface DocsBatchUpdateResult {
  replies?: unknown[];
  writeControl: { requiredRevisionId: string };
}

async function docsRequest(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  const doFetch: GoogleFetch = opts.fetch ?? fetch;
  let response;
  try {
    response = await doFetch(`${GOOGLE_DOCS_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleDocsError('could not reach Google Docs', 'network');
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { status?: unknown; errors?: { reason?: unknown }[] };
  };
  if (!response.ok) {
    const classic = payload.error?.errors?.[0]?.reason;
    const modern = payload.error?.status;
    const raw = typeof classic === 'string' ? classic : typeof modern === 'string' ? modern : '';
    const slug = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    throw new GoogleDocsError(
      `Google Docs returned an unexpected status (${String(response.status)})`,
      `http_${String(response.status)}${slug.length > 0 ? `_${slug}` : ''}`,
    );
  }
  return payload;
}

export async function getDocsDocument(
  accessToken: string,
  documentId: string,
  opts: GoogleTransportOptions = {},
): Promise<DocsDocument> {
  const payload = (await docsRequest(
    accessToken,
    `/documents/${encodeURIComponent(documentId)}?includeTabsContent=true&fields=documentId,title,revisionId,tabs`,
    {},
    opts,
  )) as { documentId?: unknown; title?: unknown; revisionId?: unknown; tabs?: unknown };
  if (
    typeof payload.documentId !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.revisionId !== 'string'
  ) {
    throw new GoogleDocsError('Google Docs returned malformed document data', 'malformed');
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_DOCUMENT_BYTES) {
    throw new GoogleDocsError('Google Docs document exceeds the 1 MB read limit', 'too_large');
  }
  return {
    documentId: payload.documentId,
    title: payload.title,
    revisionId: payload.revisionId,
    ...(payload.tabs === undefined ? {} : { tabs: payload.tabs }),
  };
}

export async function getDocsDocumentMetadata(
  accessToken: string,
  documentId: string,
  opts: GoogleTransportOptions = {},
): Promise<DocsDocument> {
  const payload = (await docsRequest(
    accessToken,
    `/documents/${encodeURIComponent(documentId)}?includeTabsContent=true&fields=documentId,title,revisionId,tabs(tabProperties,childTabs(tabProperties))`,
    {},
    opts,
  )) as { documentId?: unknown; title?: unknown; revisionId?: unknown; tabs?: unknown };
  if (
    typeof payload.documentId !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.revisionId !== 'string'
  ) {
    throw new GoogleDocsError('Google Docs returned malformed document metadata', 'malformed');
  }
  return {
    documentId: payload.documentId,
    title: payload.title,
    revisionId: payload.revisionId,
    ...(payload.tabs === undefined ? {} : { tabs: payload.tabs }),
  };
}

export async function updateDocsDocument(
  accessToken: string,
  documentId: string,
  requests: readonly unknown[],
  requiredRevisionId: string | undefined,
  opts: GoogleTransportOptions = {},
): Promise<DocsBatchUpdateResult> {
  const payload = (await docsRequest(
    accessToken,
    `/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: {
        requests,
        ...(requiredRevisionId === undefined ? {} : { writeControl: { requiredRevisionId } }),
      },
    },
    opts,
  )) as { replies?: unknown[]; writeControl?: { requiredRevisionId?: unknown } };
  const revisionId = payload.writeControl?.requiredRevisionId;
  if (typeof revisionId !== 'string') {
    throw new GoogleDocsError('Google Docs returned no post-update revision', 'malformed');
  }
  return {
    ...(Array.isArray(payload.replies) ? { replies: payload.replies } : {}),
    writeControl: { requiredRevisionId: revisionId },
  };
}

const SUPPORTED_EDIT_REQUESTS = new Set([
  'insertText',
  'deleteContentRange',
  'replaceAllText',
  'updateTextStyle',
  'updateParagraphStyle',
  'createParagraphBullets',
  'deleteParagraphBullets',
  'insertPageBreak',
  'insertTable',
  'insertTableRow',
  'insertTableColumn',
  'deleteTableRow',
  'deleteTableColumn',
  'updateTableCellStyle',
  'mergeTableCells',
  'unmergeTableCells',
]);

export function docsRequestsAreSupported(requests: readonly Record<string, unknown>[]): boolean {
  return requests.every((request) => {
    const keys = Object.keys(request);
    return keys.length === 1 && SUPPORTED_EDIT_REQUESTS.has(keys[0] ?? '');
  });
}

export function docsRequestsNeedRevision(requests: readonly Record<string, unknown>[]): boolean {
  return requests.some((request) => {
    const insertText = request.insertText as { location?: unknown } | undefined;
    if (insertText !== undefined) return insertText.location !== undefined;
    const insertPageBreak = request.insertPageBreak as { location?: unknown } | undefined;
    if (insertPageBreak !== undefined) return insertPageBreak.location !== undefined;
    const insertTable = request.insertTable as { location?: unknown } | undefined;
    if (insertTable !== undefined) return insertTable.location !== undefined;
    return true;
  });
}
