import { MOCKUP_HTML_ATTACHMENT, attachmentContentAddress } from '@verity/store';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MAX_HTML_MOCKUP_BYTES,
  MockupPreviewLimitError,
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
  app.get('/attachments/:hash', async (request, reply) => {
    const { hash } = attachmentParams.parse(request.params);
    const blob = await deps.getAttachment(hash);
    if (!blob || blob.mediaType === MOCKUP_HTML_ATTACHMENT) {
      return reply.code(404).send({ error: 'attachment not found' });
    }
    return attachmentDownloadHeaders(reply, blob.mediaType).send(blob.bytes);
  });

  app.get('/sessions/:id/mockup-attachments/:hash', async (request, reply) => {
    const { id, hash } = attachmentParams.extend({ id: z.string().min(1) }).parse(request.params);
    const blob = await deps.getAttachment(hash, MAX_HTML_MOCKUP_BYTES);
    if (
      !blob ||
      blob.mediaType !== MOCKUP_HTML_ATTACHMENT ||
      blob.bytes.length > MAX_HTML_MOCKUP_BYTES ||
      attachmentContentAddress(blob.bytes, id) !== hash
    ) {
      return reply.code(404).send({ error: 'attachment not found' });
    }
    let preview: string;
    try {
      preview = mockupPreviewDocument(blob.bytes.toString('utf8'));
    } catch (error) {
      if (!(error instanceof MockupPreviewLimitError)) throw error;
      return reply.code(422).send({ error: error.message });
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', mockupPreviewPolicy)
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .send(preview);
  });
}
