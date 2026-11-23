import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MAX_HTML_MOCKUP_BYTES,
  mockupPreviewDocument,
  mockupPreviewPolicy,
} from './mockup-preview.js';

const attachmentParams = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid attachment id'),
});

export interface AttachmentRouteDeps {
  getAttachment: (
    hash: string,
    maxBytes?: number,
  ) => Promise<{ mediaType: string; bytes: Buffer } | undefined>;
}

/** HTML snapshots are only renderable through the isolated preview endpoint. */
export function attachmentDownloadHeaders(reply: FastifyReply, mediaType: string): FastifyReply {
  reply
    .header('Content-Type', mediaType)
    .header('Cache-Control', 'private, max-age=31536000, immutable');
  if (mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html') {
    reply
      .header('Content-Disposition', 'attachment; filename="mockup.html"')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('X-Content-Type-Options', 'nosniff');
  }
  return reply;
}

/** Registers immutable reads for content-addressed session attachments. */
export function registerAttachmentRoute(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  app.get(
    '/attachments/:hash',
    async (request, reply): Promise<Buffer | string | { error: string }> => {
      const { hash } = attachmentParams.parse(request.params);
      const preview = (request.query as { mockup?: string }).mockup === '1';
      const blob = await deps.getAttachment(hash, preview ? MAX_HTML_MOCKUP_BYTES : undefined);
      if (
        !blob ||
        (preview && (blob.mediaType !== 'text/html' || blob.bytes.length > MAX_HTML_MOCKUP_BYTES))
      ) {
        reply.code(404);
        return { error: 'attachment not found' };
      }
      if (preview) {
        reply
          .type('text/html; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .header('Content-Security-Policy', mockupPreviewPolicy)
          .header('Referrer-Policy', 'no-referrer')
          .header('X-Content-Type-Options', 'nosniff');
        return mockupPreviewDocument(blob.bytes.toString('utf8'));
      }
      attachmentDownloadHeaders(reply, blob.mediaType);
      return blob.bytes;
    },
  );
}
