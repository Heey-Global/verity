import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mockupPreviewDocument, mockupPreviewPolicy } from './mockup-preview.js';

const attachmentParams = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid attachment id'),
});

export interface AttachmentRouteDeps {
  getAttachment: (hash: string) => Promise<{ mediaType: string; bytes: Buffer } | undefined>;
}

/** Registers immutable reads for content-addressed session attachments. */
export function registerAttachmentRoute(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  app.get(
    '/attachments/:hash',
    async (request, reply): Promise<Buffer | string | { error: string }> => {
      const { hash } = attachmentParams.parse(request.params);
      const blob = await deps.getAttachment(hash);
      const preview = (request.query as { mockup?: string }).mockup === '1';
      if (!blob || (preview && blob.mediaType !== 'text/html')) {
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
      reply
        .header('Content-Type', blob.mediaType)
        .header('Cache-Control', 'private, max-age=31536000, immutable');
      if (blob.mediaType === 'text/html') {
        // The raw snapshot is a download. A direct visit must
        // never execute the document on the API origin.
        reply
          .header('Content-Disposition', 'attachment; filename="mockup.html"')
          .header('Content-Security-Policy', "sandbox; default-src 'none'")
          .header('X-Content-Type-Options', 'nosniff');
      }
      return blob.bytes;
    },
  );
}
