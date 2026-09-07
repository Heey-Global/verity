import { randomUUID } from 'node:crypto';
import type { EventStore, GoogleSlideImageCleanupRecord } from '@verity/store';

import {
  deleteDriveFile,
  deleteDrivePermission,
  shareDriveFileWithLink,
  uploadDriveImage,
} from './google-drive.js';
import {
  getSlidesPage,
  getSlidesPresentation,
  getSlidesThumbnail,
  slidesRequestsAreSupported,
  slidesRequestsNeedRevision,
  updateSlidesPresentation,
} from './google-slides.js';
import { richMcpToolResult } from './mcp-tool-result.js';

const MAX_IMAGE_BYTES = 50_000_000;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_THUMBNAIL_BYTES = 10_000_000;
const THUMBNAIL_TIMEOUT_MS = 20_000;

type SlidesToolRequest = {
  action: 'inspect_deck' | 'read_slide' | 'edit' | 'thumbnail' | 'insert_image';
  slideId?: string;
  requests?: Record<string, unknown>[];
  revisionId?: string;
  attachmentId?: string;
  asBackground?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

interface GoogleSlidesToolDeps {
  eventStore: EventStore;
  googleAccessToken: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  cleanupIntervalMs?: number;
  nowId?: () => string;
  drive?: {
    upload: typeof uploadDriveImage;
    share: typeof shareDriveFileWithLink;
    deletePermission: typeof deleteDrivePermission;
    deleteFile: typeof deleteDriveFile;
  };
  slides?: {
    presentation: typeof getSlidesPresentation;
    page: typeof getSlidesPage;
    thumbnail: typeof getSlidesThumbnail;
    update: typeof updateSlidesPresentation;
  };
}

function imageDimensions(bytes: Buffer, mediaType: string): { width: number; height: number } {
  if (
    mediaType === 'image/png' &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (
    mediaType === 'image/gif' &&
    bytes.length >= 10 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mediaType === 'image/jpeg' && bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1] ?? 0;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  throw new Error('image bytes do not match the declared PNG, JPEG, or GIF type');
}

function assertImageLimits(bytes: Buffer, mediaType: string): void {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image exceeds 50 MB');
  const dimensions = imageDimensions(bytes, mediaType);
  if (dimensions.width <= 0 || dimensions.height <= 0)
    throw new Error('image has invalid dimensions');
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error('image exceeds 25 megapixels');
  }
}

async function downloadThumbnail(doFetch: typeof fetch, url: string): Promise<Buffer> {
  const response = await doFetch(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) });
  if (!response.ok) throw new Error('Google Slides thumbnail could not be downloaded');
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_THUMBNAIL_BYTES) {
    throw new Error('Google Slides thumbnail exceeds 10 MB');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  if (response.body === null) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_THUMBNAIL_BYTES) {
      throw new Error('Google Slides thumbnail exceeds 10 MB');
    }
    return bytes;
  }
  const reader = response.body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const value = next.value as Uint8Array;
    length += value.byteLength;
    if (length > MAX_THUMBNAIL_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Google Slides thumbnail exceeds 10 MB');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export function createGoogleSlidesTool(deps: GoogleSlidesToolDeps): {
  invoke: (input: {
    projectId: string;
    sessionId: string;
    turnId: string;
    invocationId: string;
    request: unknown;
  }) => Promise<unknown>;
  recover: () => Promise<void>;
  close: () => void;
} {
  const drive =
    deps.drive ??
    ({
      upload: uploadDriveImage,
      share: shareDriveFileWithLink,
      deletePermission: deleteDrivePermission,
      deleteFile: deleteDriveFile,
    } satisfies NonNullable<GoogleSlidesToolDeps['drive']>);
  const slides =
    deps.slides ??
    ({
      presentation: getSlidesPresentation,
      page: getSlidesPage,
      thumbnail: getSlidesThumbnail,
      update: updateSlidesPresentation,
    } satisfies NonNullable<GoogleSlidesToolDeps['slides']>);
  const doFetch = deps.fetch ?? fetch;

  const assertStillAssigned = async (sessionId: string, assignmentId: string): Promise<void> => {
    const current = await deps.eventStore.getSessionSlideDeck(sessionId);
    if (current?.assignmentId !== assignmentId) {
      throw new Error('The assigned Google Slides deck changed before the operation was sent');
    }
  };

  const finishCleanup = async (
    token: string,
    cleanup: Pick<GoogleSlideImageCleanupRecord, 'id' | 'fileId' | 'permissionId'>,
  ): Promise<void> => {
    if (cleanup.permissionId !== null) {
      await drive
        .deletePermission(token, cleanup.fileId, cleanup.permissionId)
        .catch(() => undefined);
    }
    try {
      await drive.deleteFile(token, cleanup.fileId);
      await deps.eventStore.completeGoogleSlideImageCleanup(cleanup.id);
    } catch (error) {
      await deps.eventStore
        .failGoogleSlideImageCleanup(
          cleanup.id,
          error instanceof Error ? error.message : 'cleanup failed',
        )
        .catch(() => undefined);
    }
  };

  const recoverOnce = async (): Promise<void> => {
    await deps.eventStore.pruneGoogleSlideInvocations(new Date(Date.now() - 7 * 24 * 60 * 60_000));
    const pending = await deps.eventStore.listGoogleSlideImageCleanups();
    if (pending.length === 0) return;
    const token = await deps.googleAccessToken();
    if (token === undefined) return;
    for (const cleanup of pending) await finishCleanup(token, cleanup);
  };
  let recovery: Promise<void> | undefined;
  const recover = (): Promise<void> => {
    recovery ??= recoverOnce().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };

  const invoke = async (input: {
    projectId: string;
    sessionId: string;
    turnId: string;
    invocationId: string;
    request: unknown;
  }): Promise<unknown> => {
    const session = await deps.eventStore.getSession(input.sessionId);
    if (session === undefined || session.projectId !== input.projectId) {
      throw new Error('Google Slides is restricted to the calling session');
    }
    const deck = await deps.eventStore.getSessionSlideDeck(input.sessionId);
    if (deck === undefined) throw new Error('No Google Slides deck is assigned to this session');
    const token = await deps.googleAccessToken();
    if (token === undefined) throw new Error('Google Drive is not connected');
    const request = input.request as SlidesToolRequest;

    if (request.action === 'inspect_deck') {
      await assertStillAssigned(input.sessionId, deck.assignmentId);
      return { deck, presentation: await slides.presentation(token, deck.fileId) };
    }
    if (request.slideId === undefined && request.action !== 'edit') {
      throw new Error(`${request.action} requires slideId`);
    }
    if (request.action === 'read_slide') {
      await assertStillAssigned(input.sessionId, deck.assignmentId);
      return slides.page(token, deck.fileId, request.slideId as string);
    }
    if (request.action === 'thumbnail') {
      await assertStillAssigned(input.sessionId, deck.assignmentId);
      const thumbnail = await slides.thumbnail(token, deck.fileId, request.slideId as string);
      const bytes = await downloadThumbnail(doFetch, thumbnail.contentUrl);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Google Slides returned a non-PNG thumbnail');
      }
      return richMcpToolResult([
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text: JSON.stringify({ width: thumbnail.width, height: thumbnail.height }),
        },
      ]);
    }
    if (request.action === 'insert_image') {
      if (request.attachmentId === undefined || request.slideId === undefined) {
        throw new Error('insert_image requires attachmentId and slideId');
      }
      const attachmentBelongsToSession = await deps.eventStore.sessionHasAttachment(
        input.sessionId,
        request.attachmentId,
      );
      if (!attachmentBelongsToSession) {
        throw new Error('insert_image can use only an attachment from this session');
      }
      const attachment = await deps.eventStore.getAttachment(request.attachmentId);
      if (
        attachment === undefined ||
        !['image/png', 'image/jpeg', 'image/gif'].includes(attachment.mediaType)
      ) {
        throw new Error('insert_image requires a PNG, JPEG, or GIF session attachment');
      }
      assertImageLimits(attachment.bytes, attachment.mediaType);
      if (request.asBackground === true && request.revisionId === undefined) {
        throw new Error('a background image requires revisionId');
      }
      await assertStillAssigned(input.sessionId, deck.assignmentId);
      const claim = await deps.eventStore.claimGoogleSlideInvocation(input);
      if (claim.status === 'completed') return claim.result;
      if (claim.status === 'pending') {
        throw new Error('This Google Slides edit may already have run; inspect the deck first');
      }
      await assertStillAssigned(input.sessionId, deck.assignmentId);
      const uploaded = await drive.upload(token, {
        name: `verity-slide-${request.attachmentId.slice(0, 12)}`,
        mimeType: attachment.mediaType as 'image/png' | 'image/jpeg' | 'image/gif',
        bytes: attachment.bytes,
      });
      const cleanupId = (deps.nowId ?? randomUUID)();
      try {
        // Persist the file id before making it public. Deleting the file removes every
        // permission, so recovery remains safe if the process dies after share() returns
        // but before its generated permission id can be recorded.
        await deps.eventStore.createGoogleSlideImageCleanup({
          id: cleanupId,
          sessionId: input.sessionId,
          fileId: uploaded.id,
        });
      } catch (error) {
        await drive.deleteFile(token, uploaded.id).catch(() => undefined);
        throw error;
      }
      let permissionId: string | null = null;
      try {
        permissionId = await drive.share(token, uploaded.id);
        await deps.eventStore.setGoogleSlideImageCleanupPermission(cleanupId, permissionId);
        const url = `https://lh3.googleusercontent.com/d/${encodeURIComponent(uploaded.id)}`;
        const imageRequest =
          request.asBackground === true
            ? {
                updatePageProperties: {
                  objectId: request.slideId,
                  pageProperties: {
                    pageBackgroundFill: { stretchedPictureFill: { contentUrl: url } },
                  },
                  fields: 'pageBackgroundFill',
                },
              }
            : {
                createImage: {
                  url,
                  elementProperties: {
                    pageObjectId: request.slideId,
                    size: {
                      width: { magnitude: request.width ?? 320, unit: 'PT' },
                      height: { magnitude: request.height ?? 180, unit: 'PT' },
                    },
                    transform: {
                      scaleX: 1,
                      scaleY: 1,
                      translateX: request.x ?? 40,
                      translateY: request.y ?? 40,
                      unit: 'PT',
                    },
                  },
                },
              };
        const result = await slides.update(
          token,
          deck.fileId,
          [imageRequest],
          request.asBackground === true ? request.revisionId : undefined,
        );
        const revisionId = result.writeControl.requiredRevisionId;
        await deps.eventStore.updateSessionSlideDeckRevision(
          input.sessionId,
          deck.assignmentId,
          revisionId,
        );
        const response = { result, revisionId };
        await deps.eventStore.completeGoogleSlideInvocation(input.invocationId, response);
        return response;
      } finally {
        await deps.eventStore.markGoogleSlideImageCleanupReady(cleanupId).catch(() => undefined);
        await finishCleanup(token, { id: cleanupId, fileId: uploaded.id, permissionId });
      }
    }

    const requests = request.requests;
    if (requests === undefined) throw new Error('edit requires requests');
    if (!slidesRequestsAreSupported(requests))
      throw new Error('edit contains an unsupported request');
    if (slidesRequestsNeedRevision(requests) && request.revisionId === undefined) {
      throw new Error('This edit depends on previously read state and requires revisionId');
    }
    await assertStillAssigned(input.sessionId, deck.assignmentId);
    const claim = await deps.eventStore.claimGoogleSlideInvocation(input);
    if (claim.status === 'completed') return claim.result;
    if (claim.status === 'pending') {
      throw new Error('This Google Slides edit may already have run; inspect the deck first');
    }
    await assertStillAssigned(input.sessionId, deck.assignmentId);
    const result = await slides.update(token, deck.fileId, requests, request.revisionId);
    const revisionId = result.writeControl.requiredRevisionId;
    await deps.eventStore.updateSessionSlideDeckRevision(
      input.sessionId,
      deck.assignmentId,
      revisionId,
    );
    const response = { result, revisionId };
    await deps.eventStore.completeGoogleSlideInvocation(input.invocationId, response);
    return response;
  };

  void recover().catch(() => undefined);
  const timer = setInterval(
    () => void recover().catch(() => undefined),
    deps.cleanupIntervalMs ?? 15 * 60_000,
  );
  timer.unref();
  return {
    invoke: (input) => invoke(input),
    recover: () => recover(),
    close: () => clearInterval(timer),
  };
}
