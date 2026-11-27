import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  externalizeToolResultImages,
  externalizeToolResultText,
  type AgentEvent,
} from '@verity/events';
import type { Database } from './schema.js';
import { attachmentStorageRecord } from './session-mockups.js';
import { redactSecrets } from './redact.js';

/** A stored image blob: its media type and raw bytes (for serving). */
export interface AttachmentBlob {
  mediaType: string;
  bytes: Buffer;
}
export class AttachmentStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Rewrite a `tool_result`'s heavy inline payloads to content-addressed refs:
   * inline images → `id` refs (#115), and a large text output → a truncated preview
   * plus an `outputRef` to the full body. A no-op (returns the same event) when it
   * carries neither. Images are externalized first so the stored full-text body
   * already references images by id rather than re-embedding their base64. */
  async externalizeToolResult(
    event: Extract<AgentEvent, { t: 'tool_result' }>,
    putAttachment: (mediaType: string, data: string) => Promise<string>,
    putTextBlob: (jsonText: string) => Promise<string>,
  ): Promise<AgentEvent> {
    const imaged = await externalizeToolResultImages(event.output, putAttachment);
    const texted = await externalizeToolResultText(imaged.output, putTextBlob);
    if (!imaged.changed && texted.ref === undefined) return event;
    return {
      ...event,
      output: texted.output,
      ...(texted.ref !== undefined ? { outputRef: texted.ref } : {}),
    };
  }

  /**
   * Store a UTF-8 text blob content-addressed by the SHA-256 of its bytes, reusing
   * the `attachments` table (a generic content-addressed blob store). Idempotent —
   * identical text dedupes to one row. Returns the hash — the `id` a `tool_result`'s
   * `outputRef` references and a consumer fetches by. Stored as `application/json`
   * because the externalized body is the JSON serialization of the tool output.
   */
  async putTextBlob(jsonText: string): Promise<string> {
    // Redact credentials from the externalized tool-output blob too (audit M9), so
    // a token echoed in a large tool result isn't persisted in clear. Content-
    // addressed by the REDACTED bytes, so the event's outputRef stays consistent.
    const bytes = Buffer.from(redactSecrets(jsonText), 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await this.db
      .insertInto('attachments')
      .values({ hash, media_type: 'application/json', bytes })
      .onConflict((oc) => oc.column('hash').doNothing())
      .execute();
    return hash;
  }

  async putAttachment(
    mediaType: string,
    base64Data: string,
    mockupSessionId?: string,
  ): Promise<string> {
    const attachment = attachmentStorageRecord(base64Data, mediaType, mockupSessionId);
    await this.db
      .insertInto('attachments')
      .values(attachment)
      .onConflict((oc) => oc.column('hash').doNothing())
      .execute();
    return attachment.hash;
  }

  /** Read a stored blob; an optional byte ceiling filters it before transfer. */
  async getAttachment(hash: string, maxBytes?: number): Promise<AttachmentBlob | undefined> {
    let query = this.db
      .selectFrom('attachments')
      .select(['media_type', 'bytes'])
      .where('hash', '=', hash);
    if (maxBytes !== undefined) {
      query = query.where(sql<number>`octet_length(bytes)`, '<=', maxBytes);
    }
    const row = await query.executeTakeFirst();
    if (!row) return undefined;
    return { mediaType: row.media_type, bytes: Buffer.from(row.bytes) };
  }

  /** Whether a prompt in this session references the content-addressed attachment. */
  async sessionHasAttachment(sessionId: string, hash: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('events')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'prompt')
      .where(sql<boolean>`payload @> ${JSON.stringify({ attachments: [{ id: hash }] })}::jsonb`)
      .executeTakeFirst();
    return row !== undefined;
  }
}
