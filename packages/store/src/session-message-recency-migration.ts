import { sql, type Kysely } from 'kysely';

// Server-authored agent notices include setup greetings and workspace status.
// Operator notices capture user actions from workflows such as transcript requests.
// Frozen for migration 0235. Add a new migration when message classification changes.
export const sessionMessageEvent0235 = sql`(
  (type = 'prompt' and (coalesce(payload->>'text', '') <> ''
    or case when jsonb_typeof(payload->'attachments') = 'array'
         then jsonb_array_length(payload->'attachments') > 0 else false end))
  or (type = 'notice' and payload->>'role' = 'operator' and coalesce(payload->>'text', '') <> '')
  or (type = 'text' and coalesce(payload->>'delta', '') <> ''
    and payload->>'parentToolId' is null)
)`;

export const sessionMessageRecencyMigration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create index events_session_message_recency_idx
      on events (session_id, id) where ${sessionMessageEvent0235}`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop index events_session_message_recency_idx`.execute(db);
  },
};
