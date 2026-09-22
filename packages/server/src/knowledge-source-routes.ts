import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import {
  type EventStore,
  KnowledgeError,
  type KnowledgeStore,
  type KnowledgeSource,
  type KnowledgeSourceSummary,
} from '@verity/store';
import { z } from 'zod';
import { processKnowledgeSource } from './knowledge-source-processing.js';
import { ensureProjectKnowledge } from './knowledge-folder.js';
import { ingestKnowledgeBytes } from './knowledge-file-ingest.js';

const id = z.string().min(1).max(128);
const file = { filename: z.string().min(1).max(150), base64: z.string().min(4).max(13_981_016) };
const SOURCE_BUNDLE_MAX_BYTES = 21_000_000;
function metadata(source: KnowledgeSource): KnowledgeSourceSummary {
  const { bytes, ...summary } = source;
  void bytes;
  return summary;
}
function decode(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    throw new KnowledgeError('invalid', 'File must use canonical base64 encoding');
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result) + Buffer.byteLength(character) > maxBytes) break;
    result += character;
  }
  return result;
}

/** These management endpoints inherit the paired-device authentication gate. */
export function registerKnowledgeSourceRoutes(
  app: FastifyInstance,
  deps: {
    knowledge: KnowledgeStore;
    store?: Pick<EventStore, 'getSession'>;
    dataRoot?: string | undefined;
  },
): void {
  const knowledge = deps.knowledge;
  void app.register((instance, _options, done) => {
    instance.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError)
        return reply.code(400).send({ error: 'Invalid source request' });
      if (error instanceof KnowledgeError)
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      throw error;
    });
    instance.post('/knowledge/sources', { bodyLimit: 14_100_000 }, async (request) => {
      const body = z
        .object({ folderId: id, ...file })
        .strict()
        .parse(request.body);
      const source = await processKnowledgeSource(body.filename, decode(body.base64));
      const bodyMarkdown = [
        source.processingNote,
        ...source.locators.map((part) => `## ${part.label}\n\n${part.text}`),
      ].join('\n\n');
      const projectId = await knowledge.projectForSourceFolder(body.folderId);
      const document = await knowledge.createSourceDocument(
        { folderId: body.folderId, title: body.filename, bodyMarkdown },
        (tx, doc) => knowledge.sources.attachRevision(tx, doc.currentRevisionId, source),
        projectId ?? undefined,
      );
      return {
        document,
        source: metadata(await knowledge.sources.getRevision(document.currentRevisionId)),
      };
    });
    instance.post('/sessions/:id/knowledge-sources', { bodyLimit: 14_100_000 }, async (request) => {
      if (!deps.store) throw new KnowledgeError('not_found');
      const { id: sessionId } = z.object({ id }).parse(request.params);
      const body = z
        .object({
          messageId: id.optional(),
          text: z.string().trim().min(1).max(262_144).optional(),
          attachments: z
            .array(z.object({ filename: file.filename, base64: file.base64 }).strict())
            .max(10)
            .default([]),
        })
        .strict()
        .refine((value) => value.text !== undefined || value.attachments.length > 0)
        .parse(request.body);
      const session = await deps.store.getSession(sessionId);
      if (!session?.projectId)
        throw new KnowledgeError('forbidden', 'Project Knowledge requires a project session');
      if (!deps.dataRoot) throw new KnowledgeError('conflict', 'Knowledge storage is unavailable');
      // Validate the entire batch before creating the first file. A malformed
      // second attachment must not leave the preceding note behind.
      const decodedAttachments = body.attachments.map((attachment) => ({
        ...attachment,
        bytes: decode(attachment.base64),
      }));
      const root = await ensureProjectKnowledge(deps.dataRoot, session.projectId);
      const paths: string[] = [];
      if (body.text) {
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
        const suffix = body.messageId
          ? `-${body.messageId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24)}`
          : `-${randomUUID()}`;
        const path = `notes/${stamp}${suffix}.md`;
        paths.push(
          await ingestKnowledgeBytes(
            root,
            path,
            Buffer.from(
              `From session ${sessionId}${body.messageId ? `, message ${body.messageId}` : ''}.\n\n${body.text}\n`,
              'utf8',
            ),
          ),
        );
      }
      for (const attachment of decodedAttachments) {
        const { bytes } = attachment;
        const safeName = attachment.filename.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 150);
        const extensionIndex = safeName.lastIndexOf('.');
        const rawStem = extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
        const rawExtension = extensionIndex > 0 ? safeName.slice(extensionIndex) : '';
        const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
        const extension = truncateUtf8(rawExtension, 40);
        const stem = truncateUtf8(rawStem, 200 - Buffer.byteLength(extension)) || 'file';
        paths.push(
          await ingestKnowledgeBytes(root, `imports/${stem}-${digest}${extension}`, bytes),
        );
      }
      return { paths };
    });
    instance.put('/knowledge/documents/:id/source', { bodyLimit: 14_100_000 }, async (request) => {
      const { id: documentId } = z.object({ id }).parse(request.params);
      const body = z
        .object({ expectedRevisionId: id, ...file })
        .strict()
        .parse(request.body);
      const source = await processKnowledgeSource(body.filename, decode(body.base64));
      const bodyMarkdown = [
        source.processingNote,
        ...source.locators.map((part) => `## ${part.label}\n\n${part.text}`),
      ].join('\n\n');
      const current = await knowledge.getDocument(documentId);
      const projectId = await knowledge.projectForSourceFolder(current.folderId);
      const document = await knowledge.updateSourceDocument(
        documentId,
        { expectedRevisionId: body.expectedRevisionId, title: body.filename, bodyMarkdown },
        (tx, doc) => knowledge.sources.attachRevision(tx, doc.currentRevisionId, source),
        projectId ?? undefined,
      );
      return {
        document,
        source: metadata(await knowledge.sources.getRevision(document.currentRevisionId)),
      };
    });
    instance.get('/knowledge/documents/:id/source', async (request) => {
      const { id: documentId } = z.object({ id }).parse(request.params);
      const { revisionId } = z.object({ revisionId: id.optional() }).parse(request.query);
      const doc = await knowledge.getDocument(documentId, revisionId);
      try {
        return { source: metadata(await knowledge.sources.getRevision(doc.currentRevisionId)) };
      } catch (error) {
        if (error instanceof KnowledgeError && error.code === 'not_found') return { source: null };
        throw error;
      }
    });
    instance.get('/knowledge/documents/:id/original', async (request, reply) => {
      const { id: documentId } = z.object({ id }).parse(request.params);
      const { revisionId } = z.object({ revisionId: id.optional() }).parse(request.query);
      const doc = await knowledge.getDocument(documentId, revisionId);
      const source = await knowledge.sources.getRevision(doc.currentRevisionId);
      return reply
        .type(source.mediaType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          `attachment; filename="source"; filename*=UTF-8''${encodeURIComponent(source.filename).replace(/'/gu, '%27')}`,
        )
        .send(source.bytes);
    });
    instance.get('/knowledge/source-bundle', async (request) => {
      const { folderId } = z.object({ folderId: id.optional() }).parse(request.query);
      const bundle = {
        version: 1 as const,
        documents: await knowledge.exportDocuments(folderId, true),
      };
      if (Buffer.byteLength(JSON.stringify(bundle)) > SOURCE_BUNDLE_MAX_BYTES)
        throw new KnowledgeError('invalid', 'Source bundle is too large; export a smaller folder');
      return bundle;
    });
    instance.post('/knowledge/source-bundle', { bodyLimit: 21_100_000 }, async (request) => {
      const original = z
        .object({
          filename: file.filename,
          base64: file.base64,
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          mediaType: z.enum([
            'application/octet-stream',
            'application/pdf',
            'image/png',
            'image/jpeg',
            'image/svg+xml',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ]),
          processingState: z.enum(['ready', 'unsupported', 'failed']),
          processingNote: z.string().max(1000),
          locators: z
            .array(
              z.object({ label: z.string().max(1000), text: z.string().max(180_000) }).strict(),
            )
            .max(100),
          previews: z
            .array(
              z
                .object({
                  label: z.string().max(1000),
                  mediaType: z.literal('image/png'),
                  base64: z
                    .string()
                    .max(8 * 1024 * 1024)
                    .refine((value) => {
                      const bytes = Buffer.from(value, 'base64');
                      return (
                        bytes.toString('base64') === value &&
                        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                      );
                    }),
                })
                .strict(),
            )
            .max(20),
        })
        .strict();
      const body = z
        .object({
          folderId: id,
          version: z.literal(1),
          documents: z
            .array(
              z
                .object({
                  path: z.string().min(1).max(2048),
                  bodyMarkdown: z.string().max(262_144),
                  original: original.optional(),
                })
                .strict(),
            )
            .max(100),
        })
        .strict()
        .parse(request.body);
      const imported = await knowledge.importDocuments(
        body.folderId,
        body.documents.map(({ original, ...document }) =>
          original ? { ...document, original } : document,
        ),
        true,
      );
      return { imported };
    });
    done();
  });
}
