import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema.js';
import { KnowledgeError } from './knowledge.js';

export const KNOWLEDGE_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export interface KnowledgeSourceInput {
  filename: string;
  bytes: Buffer;
  mediaType: string;
  processingState: 'ready' | 'unsupported' | 'failed';
  processingNote: string;
  locators: { label: string; text: string }[];
  previews: { label: string; mediaType: 'image/png'; base64: string }[];
}
export interface KnowledgeSourceSummary extends Omit<KnowledgeSourceInput, 'bytes'> {
  revisionId: string;
  size: number;
  sha256: string;
}
export interface KnowledgeSource extends KnowledgeSourceSummary {
  bytes: Buffer;
}

/** Original bytes share the document revision's lifetime, identity and database backup. */
export class KnowledgeSourceStore {
  constructor(private readonly db: Kysely<Database>) {}

  async attachRevision(
    tx: Transaction<Database>,
    revisionId: string,
    input: KnowledgeSourceInput,
  ): Promise<void> {
    if (
      !input.bytes.length ||
      input.bytes.length > KNOWLEDGE_SOURCE_MAX_BYTES ||
      !input.filename ||
      input.filename.length > 150 ||
      /[\\/]/u.test(input.filename) ||
      [...input.filename].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    ) {
      throw new KnowledgeError('invalid', 'Source must have a filename and contain at most 10 MiB');
    }
    await tx
      .insertInto('knowledge_source_revisions')
      .values({
        revision_id: revisionId,
        filename: input.filename,
        bytes: input.bytes,
        media_type: input.mediaType,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        processing_state: input.processingState,
        processing_note: input.processingNote,
        locators: sql`${JSON.stringify(input.locators)}::jsonb`,
        previews: sql`${JSON.stringify(input.previews)}::jsonb`,
      })
      .execute();
  }

  async getRevision(revisionId: string, tx?: Transaction<Database>): Promise<KnowledgeSource> {
    const row = await (tx ?? this.db)
      .selectFrom('knowledge_source_revisions')
      .selectAll()
      .where('revision_id', '=', revisionId)
      .executeTakeFirst();
    if (!row)
      throw new KnowledgeError('not_found', 'Original source is unavailable for this revision');
    const bytes = Buffer.from(row.bytes);
    return {
      revisionId: row.revision_id,
      filename: row.filename,
      mediaType: row.media_type,
      size: bytes.length,
      bytes,
      sha256: row.sha256,
      processingState: row.processing_state as KnowledgeSourceInput['processingState'],
      processingNote: row.processing_note,
      locators: row.locators,
      previews: row.previews as KnowledgeSourceInput['previews'],
    };
  }
}
