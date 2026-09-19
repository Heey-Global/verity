import type { GoogleFetch, GoogleTransportOptions } from './google-drive.js';

const GOOGLE_SLIDES_API = 'https://slides.googleapis.com/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

export class GoogleSlidesError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GoogleSlidesError';
  }
}

export interface SlidesPresentationSummary {
  presentationId: string;
  title: string;
  revisionId: string;
  slideIds: string[];
}

export interface SlidesBatchUpdateResult {
  replies?: unknown[];
  writeControl: { requiredRevisionId: string };
}

async function slidesRequest(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  const doFetch: GoogleFetch = opts.fetch ?? fetch;
  let response;
  try {
    response = await doFetch(`${GOOGLE_SLIDES_API}${path}`, {
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
    throw new GoogleSlidesError('could not reach Google Slides', 'network');
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { status?: unknown; errors?: { reason?: unknown }[] };
  };
  if (!response.ok) {
    const classic = payload.error?.errors?.[0]?.reason;
    const modern = payload.error?.status;
    const raw = typeof classic === 'string' ? classic : typeof modern === 'string' ? modern : '';
    const slug = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    throw new GoogleSlidesError(
      `Google Slides returned an unexpected status (${String(response.status)})`,
      `http_${String(response.status)}${slug.length > 0 ? `_${slug}` : ''}`,
    );
  }
  return payload;
}

export async function getSlidesPresentation(
  accessToken: string,
  presentationId: string,
  opts: GoogleTransportOptions = {},
): Promise<SlidesPresentationSummary> {
  const payload = (await slidesRequest(
    accessToken,
    `/presentations/${encodeURIComponent(presentationId)}?fields=presentationId,title,revisionId,slides.objectId`,
    {},
    opts,
  )) as {
    presentationId?: unknown;
    title?: unknown;
    revisionId?: unknown;
    slides?: { objectId?: unknown }[];
  };
  if (
    typeof payload.presentationId !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.revisionId !== 'string'
  ) {
    throw new GoogleSlidesError(
      'Google Slides returned malformed presentation metadata',
      'malformed',
    );
  }
  return {
    presentationId: payload.presentationId,
    title: payload.title,
    revisionId: payload.revisionId,
    slideIds: (payload.slides ?? [])
      .map((slide) => slide.objectId)
      .filter((id): id is string => typeof id === 'string'),
  };
}

export async function getSlidesPage(
  accessToken: string,
  presentationId: string,
  pageObjectId: string,
  opts: GoogleTransportOptions = {},
): Promise<unknown> {
  return slidesRequest(
    accessToken,
    `/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}`,
    {},
    opts,
  );
}

export async function updateSlidesPresentation(
  accessToken: string,
  presentationId: string,
  requests: readonly unknown[],
  requiredRevisionId: string | undefined,
  opts: GoogleTransportOptions = {},
): Promise<SlidesBatchUpdateResult> {
  const payload = (await slidesRequest(
    accessToken,
    `/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
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
    throw new GoogleSlidesError('Google Slides returned no post-update revision', 'malformed');
  }
  return {
    ...(Array.isArray(payload.replies) ? { replies: payload.replies } : {}),
    writeControl: { requiredRevisionId: revisionId },
  };
}

export async function getSlidesThumbnail(
  accessToken: string,
  presentationId: string,
  pageObjectId: string,
  opts: GoogleTransportOptions = {},
): Promise<{ contentUrl: string; width?: number; height?: number }> {
  const payload = (await slidesRequest(
    accessToken,
    `/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=MEDIUM`,
    {},
    opts,
  )) as { contentUrl?: unknown; width?: unknown; height?: unknown };
  if (typeof payload.contentUrl !== 'string') {
    throw new GoogleSlidesError('Google Slides returned malformed thumbnail metadata', 'malformed');
  }
  return {
    contentUrl: payload.contentUrl,
    ...(typeof payload.width === 'number' ? { width: payload.width } : {}),
    ...(typeof payload.height === 'number' ? { height: payload.height } : {}),
  };
}

export function slidesRequestsNeedRevision(requests: readonly Record<string, unknown>[]): boolean {
  return requests.some((request) => {
    if ('replaceAllText' in request || 'updatePageElementTransform' in request) return true;
    if ('updatePageProperties' in request) return true;
    const insert = request.insertText as { insertionIndex?: unknown } | undefined;
    if (insert?.insertionIndex !== undefined) return true;
    const slide = request.createSlide as { insertionIndex?: unknown } | undefined;
    if (slide?.insertionIndex !== undefined) return true;
    for (const key of [
      'deleteText',
      'updateTextStyle',
      'updateParagraphStyle',
      'createParagraphBullets',
    ] as const) {
      const operation = request[key] as { textRange?: { type?: unknown } } | undefined;
      if (operation?.textRange?.type === 'FIXED_RANGE') return true;
    }
    return false;
  });
}

const SUPPORTED_EDIT_REQUESTS = new Set([
  'insertText',
  'deleteText',
  'replaceAllText',
  'updateTextStyle',
  'updateParagraphStyle',
  'createParagraphBullets',
  'createShape',
  'duplicateObject',
  'createSlide',
  'deleteObject',
  'updatePageElementTransform',
]);

export function slidesRequestsAreSupported(requests: readonly Record<string, unknown>[]): boolean {
  return requests.every((request) => {
    const keys = Object.keys(request);
    return keys.length === 1 && SUPPORTED_EDIT_REQUESTS.has(keys[0] ?? '');
  });
}
