import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const attachmentParams = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/, 'invalid attachment id'),
});

export interface AttachmentRouteDeps {
  getAttachment: (hash: string) => Promise<{ mediaType: string; bytes: Buffer } | undefined>;
}

/** Registers immutable reads for content-addressed session attachments. */
export function registerAttachmentRoute(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  app.get('/attachments/:hash', async (request, reply): Promise<Buffer | { error: string }> => {
    const { hash } = attachmentParams.parse(request.params);
    const blob = await deps.getAttachment(hash);
    if (!blob) {
      reply.code(404);
      return { error: 'attachment not found' };
    }
    reply
      .header('Content-Type', blob.mediaType)
      .header('Cache-Control', 'private, max-age=31536000, immutable');
    return blob.bytes;
  });
}
